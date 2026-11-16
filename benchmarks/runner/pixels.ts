/// <reference types="node" />
// Compares frames that redraw only the columns a tick changed with full redraws, pixel for pixel, in
// headless Chromium (see `benchmarks/src/pixels/main.ts`).
// Usage: pnpm bench:pixels [--dpr 1,2,1.5] [--raster gpu,cpu] [--case <part of a name>] [--out <file.json>]
//
// Exits with 1 when any comparison differs, or when a case took no partial frame at all.
//
// `--raster cpu` has the canvases rasterized in software (as a canvas that is read often is). There
// the comparison cannot hold for antialiased lines, and its differences are reported without
// failing: Chromium's software rasterizer draws the far end of a line slightly differently when
// its last point moves, so two full redraws already differ where nothing changed
// (docs/benchmarks/stage-5-partial-redraw.md).

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import type { PixelCase, PixelResult } from '../src/pixels/main.ts';

const benchDir = fileURLToPath(new URL('..', import.meta.url));
const invokedFrom = process.env['INIT_CWD'] ?? process.cwd();
const { values: args } = parseArgs({
	options: {
		dpr: { type: 'string', default: '1,2,1.5' },
		raster: { type: 'string', default: 'gpu' },
		case: { type: 'string' },
		out: { type: 'string' },
	},
});
const ratios = args.dpr.split(',').map(Number);
const rasters = args.raster.split(',');

async function main(): Promise<void> {
	const configFile = resolve(benchDir, 'vite.config.ts');
	await build({ configFile, logLevel: 'warn' });
	const server = await preview({ configFile, logLevel: 'warn' });
	const baseUrl = server.resolvedUrls?.local[0];
	if (baseUrl === undefined) {
		throw new Error('Preview server has no local URL');
	}
	// New headless mode rasterizes on the GPU, like a window (see `cli.ts`).
	const browser = await chromium.launch({ headless: true, channel: 'chromium' });
	const results: (PixelResult & { dpr: number; raster: string })[] = [];
	let failed = 0;
	try {
		for (const raster of rasters) {
			for (const dpr of ratios) {
				const context = await browser.newContext({ viewport: { width: 800, height: 500 }, deviceScaleFactor: dpr });
				const page = await context.newPage();
				page.on('pageerror', error => {
					process.stdout.write(`page error: ${error.message}\n`);
					failed++;
				});
				await page.goto(`${baseUrl}pixels.html?raster=${raster}`);
				await page.waitForFunction(() => window.pixels !== undefined);
				const cases = (await page.evaluate(() => window.pixels!.cases)) as PixelCase[];
				for (const entry of cases) {
					if (args.case !== undefined && !entry.name.includes(args.case)) {
						continue;
					}
					const result = await page.evaluate(name => window.pixels!.run(name), entry.name);
					results.push({ ...result, dpr, raster });
					const ok = result.different === 0 && result.partial > 0;
					if (!ok && raster !== 'cpu') {
						failed++;
					}
					process.stdout.write(
						`${ok ? 'ok  ' : raster === 'cpu' ? 'note' : 'FAIL'} ${raster} dpr ${dpr} ${result.name}: ${result.partial} partial ` +
							`(${result.clipMin}-${result.clipMax} px), ${result.full} full, ${result.kept} kept; ` +
							`${result.compared} compared, ${result.different} differ` +
							(result.different > 0
								? ` (${result.differentPixels} pixels, by up to ${result.largestDifference}; ${result.firstDifference})`
								: '') +
							'\n',
					);
				}
				await context.close();
			}
		}
	} finally {
		await browser.close();
		await new Promise<void>(done => server.httpServer.close(() => done()));
	}
	const sum = (pick: (result: PixelResult) => number): number => results.reduce((total, r) => total + pick(r), 0);
	process.stdout.write(
		`${results.length} cases: ${sum(r => r.partial)} partial frames, ${sum(r => r.full)} full, ${sum(r => r.kept)} kept; ` +
			`${sum(r => r.compared)} comparisons, ${sum(r => r.different)} differ\n`,
	);
	if (args.out !== undefined) {
		const version = browser.version();
		writeFileSync(
			resolve(invokedFrom, args.out),
			`${JSON.stringify({ createdAt: new Date().toISOString(), chromium: version, results }, null, '\t')}\n`,
		);
	}
	process.exit(failed > 0 ? 1 : 0);
}

await main();
