import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'vite';

const isFocused = control => control.evaluate(el => el === document.activeElement);

const { values } = parseArgs({ options: { browser: { type: 'string', default: 'chromium' } } });
const engine = { chromium, firefox, webkit }[values.browser];
const configFile = new URL('../vite.config.ts', import.meta.url).pathname;
const server = await createServer({
	configFile,
	logLevel: 'error',
	server: { host: '127.0.0.1', port: 0, open: false },
});
let browser;
try {
	await server.listen();
	browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chromium' } : {}) });
	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', e => errors.push(String(e)));
	await page.goto(server.resolvedUrls.local[0] + 'fixtures/accessibility.html');
	await page.waitForFunction(() => window.chartsReady);
	const north = page.getByRole('slider', { name: 'North market data' });
	const south = page.getByRole('slider', { name: 'South market data' });
	const settle = () => page.evaluate(() => Promise.all(window.charts.map(chart => chart.whenIdle())));
	const text = () => page.getByRole('group', { name: 'North market' }).getByRole('status').textContent();
	await page.getByRole('button', { name: 'Before charts' }).focus();
	await page.keyboard.press('Tab');
	assert.equal(await isFocused(north), true);
	assert.equal(await north.evaluate(el => getComputedStyle(el.parentElement).clipPath), 'none');
	assert.match(await text(), /Bid candlestick, open/);
	await page.keyboard.press('Home');
	await settle();
	assert.match(
		await text(),
		/Bar 1\. 2025-01-01 00:00\. Bid candlestick, open 90.00, high 95.00, low 88.00, close 93.00/,
	);
	await page.keyboard.press('ArrowRight');
	assert.match(await text(), /Bar 2\. 2025-01-01 01:00/);
	if (engine === chromium) {
		const cdp = await page.context().newCDPSession(page);
		const { nodes } = await cdp.send('Accessibility.getFullAXTree');
		const control = nodes.find(n => !n.ignored && n.role.value === 'slider' && n.name.value === 'North market data');
		assert.match(
			control.description.value,
			/ArrowLeft or ArrowDown to inspect the previous sample.*Hourly market prices.*300 bars/,
		);
		assert.equal(control.value.value, 2);
		const status = nodes.find(n => n.role.value === 'status' && n.childIds.length);
		assert.equal(status.properties.find(p => p.name === 'live').value.value, 'polite');
		assert.ok(nodes.some(n => status.childIds.includes(n.nodeId) && /Bar 2.*Bid candlestick/.test(n.name?.value)));
		assert.equal(nodes.filter(n => !n.ignored && n.role.value === 'slider').length, 2);
		assert.equal(
			nodes.some(n => !n.ignored && n.role.value === 'Canvas'),
			false,
		);
		await cdp.detach();
	}
	const extent = () =>
		page.evaluate(() => {
			const range = window.charts[0].timeScale().getVisibleLogicalRange();
			return range.to - range.from;
		});
	const initial = await extent();
	await page.keyboard.press('=');
	await settle();
	assert.ok((await extent()) < initial);
	await page.keyboard.press('End');
	await settle();
	assert.match(await text(), /^Bar 300\./);
	assert.equal(await south.inputValue(), '196');
	await page.keyboard.press('Tab');
	assert.equal(await isFocused(south), true);
	await page.evaluate(() =>
		window.charts[1].applyOptions({
			accessibility: {
				keyBindings: { first: ['Cmd+Shift+F8'], next: ['Ctrl+Shift+K'], previous: ['Option+[KeyJ]'], refresh: [] },
			},
		}),
	);
	await page.keyboard.press('Meta+Shift+F8');
	await settle();
	assert.equal(await south.inputValue(), '1');
	await page.keyboard.press('Shift+k');
	assert.equal(await south.inputValue(), '1');
	await page.keyboard.press('Control+Shift+k');
	assert.equal(await south.inputValue(), '2');
	await page.keyboard.press('Alt+j');
	assert.equal(await south.inputValue(), '1');
	await page.keyboard.press('ArrowRight');
	assert.equal(await south.inputValue(), '2');
	assert.equal(await north.inputValue(), '300');
	const southHint = await south.evaluate(
		el => document.getElementById(el.getAttribute('aria-describedby').split(' ')[0]).textContent,
	);
	assert.match(southHint, /Ctrl\+Shift\+K/);
	assert.doesNotMatch(southHint, /refresh the reading/);

	await page.keyboard.press('Tab');
	assert.equal(await isFocused(page.locator('#after')), true);
	await page.keyboard.press('Shift+Tab');
	assert.equal(await isFocused(south), true);
	await page.evaluate(() => window.charts[1].destroy());
	assert.equal(await south.count(), 0);
	assert.deepEqual(errors, []);
	console.log(values.browser + ' passed keyboard navigation, focus, independent charts and accessible readout checks.');
} finally {
	await browser?.close();
	await server.close();
}
