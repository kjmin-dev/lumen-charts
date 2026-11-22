/// <reference types="node" />
// Drives Chrome on an Android device connected over USB: `pnpm bench --android <serial>` and
// `node benchmarks/runner/mark-charts.mjs --android <serial>`. The Mac serves the production build;
// `adb reverse` makes it the device's localhost (a secure context, so WebGPU and cross-origin
// isolation work as on the desktop), and `adb forward` reaches Chrome's DevTools socket, which
// Playwright speaks to with `connectOverCDP`. Pages open in Chrome's own profile, at the device's
// real viewport and device pixel ratio: Chrome on Android cannot create browser contexts with
// emulated windows.

import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Browser, type Page, chromium } from 'playwright';
import {
	type AndroidDevice,
	type DeviceState,
	describeDevice,
	hasAbstractSocket,
	parseBattery,
	parseGetprop,
	parseResidentBytes,
	parseThermal,
	parseVersionName,
} from '../src/android.ts';

const CHROME_PACKAGE = 'com.android.chrome';
const CHROME_ACTIVITY = `${CHROME_PACKAGE}/com.google.android.apps.chrome.Main`;
const DEVTOOLS_SOCKET = 'chrome_devtools_remote';

export interface AndroidConnection {
	readonly device: AndroidDevice;
	/** Chrome on the device. Replaced by `reconnect`. */
	browser: Browser;
	/** Opens a page in Chrome's default profile; `close()` closes every page opened this way. */
	newPage(): Promise<Page>;
	/** Battery and thermal state now. */
	state(): DeviceState;
	/** Resident memory of the given processes of the device, summed, in bytes. */
	residentBytes(pids: readonly number[]): number | null;
	/**
	 * Whether both port mappings are in place. Another adb client can restart the adb server, which
	 * drops them and leaves the DevTools connection open but silent.
	 */
	mapped(): boolean;
	/** Connects again after Chrome went away (it crashed, or the adb server restarted). */
	reconnect(): Promise<Browser>;
	/** Closes the pages opened, removes the port mappings and restores the screen setting. */
	close(): Promise<void>;
}

/** `adb` from `$ADB`, else from the `PATH`. */
function adbPath(): string {
	return process.env['ADB'] ?? 'adb';
}

/**
 * Connects to Chrome on device `serial`, starting it when it does not run, and makes the Mac's
 * port `port` the device's localhost:`port`. `cdpPort` is the Mac's end of the DevTools socket.
 */
export async function connectAndroid(serial: string, port: number, cdpPort = 9222): Promise<AndroidConnection> {
	const adb = (args: string[], timeout = 20_000): string =>
		execFileSync(adbPath(), ['-s', serial, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout,
		});
	const shell = (command: string): string => adb(['shell', command]);
	const tryShell = (command: string): string | null => {
		try {
			return shell(command);
		} catch {
			return null;
		}
	};
	if (adb(['get-state']).trim() !== 'device') {
		throw new Error(`Android device ${serial} is not ready (adb get-state)`);
	}
	const properties = parseGetprop(shell('getprop'));
	const display = [tryShell('wm size'), tryShell('wm density')]
		.map(text => text?.trim().replace(/\s+/g, ' ') ?? '')
		.filter(text => text !== '')
		.join('; ');
	const device = describeDevice(
		serial,
		properties,
		parseVersionName(tryShell(`dumpsys package ${CHROME_PACKAGE}`) ?? ''),
		display || null,
	);

	// Frames stop when the screen turns off. `svc power stayon usb` keeps it on while USB powers the
	// device; the setting it replaces is restored on close.
	const stayOn = tryShell('settings get global stay_on_while_plugged_in')?.trim() ?? '0';
	shell('svc power stayon usb');
	shell('input keyevent KEYCODE_WAKEUP');
	if (/isKeyguardShowing=true/.test(tryShell('dumpsys window') ?? '')) {
		process.stdout.write('Warning: the device is locked; unlock it so Chrome draws frames.\n');
	}

	const socketOpen = (): boolean => hasAbstractSocket(tryShell('cat /proc/net/unix') ?? '', DEVTOOLS_SOCKET);
	if (!socketOpen()) {
		shell(`am start -n ${CHROME_ACTIVITY} -d about:blank`);
		for (let i = 0; i < 40 && !socketOpen(); i++) {
			await sleep(250);
		}
		if (!socketOpen()) {
			throw new Error(`Chrome on ${serial} opened no DevTools socket: enable USB debugging and allow this computer`);
		}
	}

	const mapPorts = (): void => {
		adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
		adb(['forward', `tcp:${cdpPort}`, `localabstract:${DEVTOOLS_SOCKET}`]);
	};
	const pageUrl = `http://localhost:${port}/`;
	/** Closes the device's tabs on this server's pages, which a lost connection leaves open. */
	const closeHarnessTabs = async (browser: Browser): Promise<void> => {
		for (const page of browser.contexts()[0]?.pages() ?? []) {
			if (page.url().startsWith(pageUrl)) {
				await page.close().catch(() => undefined);
			}
		}
	};
	const connect = async (): Promise<Browser> => {
		// An adb server that restarted has dropped both mappings.
		mapPorts();
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 30_000 });
		await closeHarnessTabs(browser);
		return browser;
	};

	const opened = new Set<Page>();
	const connection: AndroidConnection = {
		device,
		browser: await connect(),
		async newPage() {
			const context = connection.browser.contexts()[0];
			if (context === undefined) {
				throw new Error('Chrome on the device has no default context');
			}
			const page = await context.newPage();
			opened.add(page);
			page.once('close', () => opened.delete(page));
			return page;
		},
		state() {
			return {
				battery: parseBattery(tryShell('dumpsys battery') ?? ''),
				thermal: parseThermal(tryShell('dumpsys thermalservice') ?? ''),
			};
		},
		residentBytes(pids) {
			return pids.length === 0 ? null : parseResidentBytes(tryShell(`ps -o RSS= -p ${pids.join(',')}`) ?? '');
		},
		mapped() {
			try {
				const forwards = execFileSync(adbPath(), ['forward', '--list'], { encoding: 'utf8', timeout: 10_000 });
				const reverses = adb(['reverse', '--list'], 10_000);
				return (
					forwards.includes(`${serial} tcp:${cdpPort} localabstract:${DEVTOOLS_SOCKET}`) &&
					reverses.includes(`tcp:${port} tcp:${port}`)
				);
			} catch {
				return false;
			}
		},
		async reconnect() {
			await connection.browser.close().catch(() => undefined);
			connection.browser = await connect();
			return connection.browser;
		},
		async close() {
			for (const page of opened) {
				await page.close().catch(() => undefined);
			}
			await closeHarnessTabs(connection.browser);
			// Disconnects only: Chrome keeps running with the tabs it had before.
			await connection.browser.close().catch(() => undefined);
			for (const args of [
				['reverse', '--remove', `tcp:${port}`],
				['forward', '--remove', `tcp:${cdpPort}`],
			]) {
				try {
					adb(args);
				} catch {
					// Already gone with a restarted adb server.
				}
			}
			if (stayOn === '0') {
				tryShell('svc power stayon false');
			} else {
				tryShell(`settings put global stay_on_while_plugged_in ${stayOn}`);
			}
		},
	};
	return connection;
}
