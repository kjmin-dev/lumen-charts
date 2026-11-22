// What the runners read from an Android device over adb, as plain data: the device's properties, its
// battery and thermal state around each run, whether Chrome's DevTools socket is open, and the
// resident memory of processes. Pure functions over the text adb prints, so they are tested in Node.

/** Properties from `adb shell getprop`, one `[name]: [value]` per line. */
export function parseGetprop(text: string): Record<string, string> {
	const properties: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const match = /^\[([^\]]+)\]: \[(.*)\]\s*$/.exec(line);
		if (match !== null) {
			properties[match[1]!] = match[2]!;
		}
	}
	return properties;
}

/** Battery state, from `adb shell dumpsys battery`. */
export interface BatteryState {
	/** Charge in percent. */
	level: number | null;
	/** Battery temperature in °C (dumpsys reports tenths of a degree). */
	temperatureC: number | null;
	/** `charging`, `discharging`, `not-charging`, `full` or `unknown`. */
	status: string;
	/** Sources the device draws power from: `ac`, `usb`, `wireless`, `dock`. */
	powered: string[];
}

/** Values of `BatteryManager.BATTERY_STATUS_*`. */
const BATTERY_STATUS: Record<number, string> = {
	1: 'unknown',
	2: 'charging',
	3: 'discharging',
	4: 'not-charging',
	5: 'full',
};

export function parseBattery(text: string): BatteryState {
	const fields = new Map<string, string>();
	for (const line of text.split('\n')) {
		const match = /^\s*([A-Za-z][A-Za-z ]*?):\s*(.*?)\s*$/.exec(line);
		// The first occurrence: later sections repeat some names with other meanings.
		if (match !== null && !fields.has(match[1]!)) {
			fields.set(match[1]!, match[2]!);
		}
	}
	const number = (name: string): number | null => {
		const value = fields.get(name);
		return value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
	};
	const temperature = number('temperature');
	const status = number('status');
	const powered = (['AC', 'USB', 'Wireless', 'Dock'] as const)
		.filter(source => fields.get(`${source} powered`) === 'true')
		.map(source => source.toLowerCase());
	return {
		level: number('level'),
		temperatureC: temperature === null ? null : temperature / 10,
		status: status === null ? 'unknown' : (BATTERY_STATUS[status] ?? `status-${status}`),
		powered,
	};
}

/** Thermal state, from `adb shell dumpsys thermalservice`. */
export interface ThermalState {
	/**
	 * `PowerManager.THERMAL_STATUS_*`: 0 none, 1 light, 2 moderate, 3 severe, 4 critical, 5
	 * emergency, 6 shutdown. Throttling starts at light or moderate, depending on the device.
	 */
	status: number | null;
	/** °C by sensor name (AP is the SoC, SKIN the case, BAT the battery), as the thermal HAL reads them now. */
	temperatures: Record<string, number>;
}

export function parseThermal(text: string): ThermalState {
	const status = /^\s*Thermal Status:\s*(\d+)/m.exec(text);
	const temperatures: Record<string, number> = {};
	// The HAL's current readings; the cached section before them can be minutes old.
	const current = text.indexOf('Current temperatures from HAL:');
	if (current >= 0) {
		for (const line of text.slice(current).split('\n').slice(1)) {
			const match = /Temperature\{mValue=(-?[\d.]+), mType=\d+, mName=([^,]+),/.exec(line);
			if (match === null) {
				break;
			}
			temperatures[match[2]!] = Number(match[1]);
		}
	}
	return { status: status === null ? null : Number(status[1]), temperatures };
}

/**
 * Whether a process listens on the abstract Unix socket `name`, from `adb shell cat /proc/net/unix`.
 * Chrome opens `chrome_devtools_remote` once it runs with USB debugging enabled on the device.
 */
export function hasAbstractSocket(procNetUnix: string, name: string): boolean {
	return procNetUnix.split('\n').some(line => line.trim().split(/\s+/).at(-1) === `@${name}`);
}

/** Resident memory summed over the lines of `ps -o RSS=` (kibibytes), in bytes; null when there is none. */
export function parseResidentBytes(text: string): number | null {
	let kibibytes = 0;
	let found = false;
	for (const line of text.split('\n')) {
		const value = line.trim();
		if (value !== '' && Number.isFinite(Number(value))) {
			kibibytes += Number(value);
			found = true;
		}
	}
	return found ? kibibytes * 1024 : null;
}

/** The first `versionName=` of `adb shell dumpsys package <name>`: the version that runs. */
export function parseVersionName(text: string): string | null {
	return /versionName=(\S+)/.exec(text)?.[1] ?? null;
}

/** Battery and thermal state of the device, sampled before and after a run. */
export interface DeviceState {
	battery: BatteryState;
	thermal: ThermalState;
}

/** The device a run used, as a results file records it. */
export interface AndroidDevice {
	serial: string;
	manufacturer: string | null;
	model: string | null;
	/** System on chip, for example SM8750 (Snapdragon 8 Elite). */
	soc: string | null;
	android: string | null;
	sdk: string | null;
	chrome: string | null;
	/** Physical size of the active display in pixels and its density, from `wm size` and `wm density`. */
	display: string | null;
}

export function describeDevice(
	serial: string,
	properties: Record<string, string>,
	chrome: string | null,
	display: string | null,
): AndroidDevice {
	const property = (name: string): string | null => properties[name] || null;
	return {
		serial,
		manufacturer: property('ro.product.manufacturer'),
		model: property('ro.product.model'),
		soc: property('ro.soc.model'),
		android: property('ro.build.version.release'),
		sdk: property('ro.build.version.sdk'),
		chrome,
		display,
	};
}
