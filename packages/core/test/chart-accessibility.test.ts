import { createChart } from '@lumen-ticks/core';
import { afterEach, describe, expect, it } from 'vitest';
import { MINUTE, TestChart, candles } from './drawing-helpers';

function press(control: HTMLElement, key: string, options: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
	control.dispatchEvent(event);
	return event.defaultPrevented;
}

describe('accessible chart data', () => {
	let t: TestChart;
	afterEach(() => t.destroy());

	it('names the instance, describes empty and visible data, and preserves its label across restore', async () => {
		t = new TestChart({ accessibility: { label: 'EUR/USD', description: 'Hourly prices.' } });
		const chart = t.chart,
			root = chart.element();
		const slider = root.querySelector('input')!;
		await t.settle();
		const summary = document.getElementById(root.getAttribute('aria-describedby')!)!;
		expect(root.getAttribute('aria-label')).toBe('EUR/USD');
		expect(summary.textContent).toContain('Hourly prices. No chart data.');
		expect(slider.getAttribute('aria-disabled')).toBe('true');
		expect([...root.querySelectorAll('canvas')].every(c => c.getAttribute('aria-hidden') === 'true')).toBe(true);
		const line = chart.addSeries('line', { id: 'Ask' });
		line.setData([
			{ time: 0, value: 10 },
			{ time: MINUTE, value: 12 },
		]);
		chart.addSeries('scatter', { id: 'Trades' });
		await t.settle();
		expect(slider.getAttribute('aria-disabled')).toBe('false');
		expect(summary.textContent).toContain('2 bars.');
		expect(summary.textContent).toContain('Ask line, Trades scatter');
		const state = chart.saveState();
		expect(state.options).not.toHaveProperty('accessibility');
		chart.applyOptions({ accessibility: { label: 'USD/JPY' } });
		chart.restoreState(state);
		line.applyOptions({ visible: false });
		await t.settle();
		expect(slider.getAttribute('aria-label')).toBe('USD/JPY data');
		expect(summary.textContent).not.toContain('Ask line');
	});

	it('moves the inspection point, pans to distant history, zooms and reads OHLC plus sparse series', async () => {
		t = new TestChart({ localization: { timeFormatter: time => 'time ' + time } });
		const chart = t.chart,
			slider = chart.element().querySelector('input')!;
		chart.addSeries('candlestick', { id: 'Price', precision: 2 }).setData(candles(300));
		chart.addSeries('histogram', { id: 'Volume', precision: 0 }).setData([{ time: 0, value: 35 }]);
		chart.timeScale().setVisibleLogicalRange({ from: 180, to: 220 });
		await t.settle();
		slider.focus();
		expect(press(slider, 'Home')).toBe(true);
		await t.settle();
		expect(chart.element().querySelector('[role=status]')!.textContent).toContain(
			'Bar 1. time 0. Price candlestick, open 100.00, high 102.00, low 98.00, close 101.00',
		);
		expect(chart.element().querySelector('[role=status]')!.textContent).toContain('Volume histogram, 35');
		expect(chart.timeScale().getVisibleLogicalRange()!.from).toBeLessThanOrEqual(0);
		press(slider, 'ArrowRight');
		await t.settle();
		expect(chart.element().querySelector('[role=status]')!.textContent).toContain('Bar 2. time 60000');
		expect(chart.element().querySelector('[role=status]')!.textContent).toContain('Volume histogram, no value');
		press(slider, 'PageUp');
		await t.settle();
		expect(Number(slider.value)).toBeGreaterThan(2);
		press(slider, 'End');
		await t.settle();
		expect(slider.value).toBe('300');
		const span = () => {
			const r = chart.timeScale().getVisibleLogicalRange()!;
			return r.to - r.from;
		};
		const before = span();
		press(slider, '+');
		await t.settle();
		expect(span()).toBeLessThan(before);
		press(slider, '0');
		await t.settle();
		expect(span()).toBeCloseTo(300);
		expect(press(slider, 'Tab')).toBe(false);
		expect(press(slider, 'Home', { ctrlKey: true })).toBe(false);
	});

	it('applies key bindings per action, updates the hint and retains them across state restoration', async () => {
		const next = ['Cmd+Shift+k'];
		t = new TestChart({ accessibility: { keyBindings: { next, refresh: [] } } });
		const chart = t.chart;
		const slider = chart.element().querySelector('input')!;
		const hint = document.getElementById(slider.getAttribute('aria-describedby')!.split(' ')[0]!)!;
		next[0] = 'z';
		chart.addSeries('candlestick').setData(candles(120));
		await t.settle();
		slider.focus();
		press(slider, 'Home');
		await t.settle();
		expect(press(slider, 'K', { metaKey: true, shiftKey: true })).toBe(true);
		expect(slider.value).toBe('2');
		expect(press(slider, 'Enter')).toBe(false);
		expect(hint.textContent).toContain('Shift+Command/Meta+K');
		expect(hint.textContent).not.toContain('refresh the reading');

		const saved = chart.saveState({ parts: ['options'] });
		chart.applyOptions({ accessibility: { keyBindings: { next: ['Alt+[KeyN]'], fitContent: ['f'] } } });
		chart.restoreState(saved);
		expect(press(slider, 'K', { metaKey: true, shiftKey: true })).toBe(false);
		expect(press(slider, 'ñ', { altKey: true, code: 'KeyN' })).toBe(true);
		expect(slider.value).toBe('3');
		expect(press(slider, 'ArrowRight')).toBe(true);
		expect(slider.value).toBe('4');
		expect(press(slider, '0')).toBe(false);
		expect(press(slider, 'f')).toBe(true);
		expect(press(slider, 'z')).toBe(false);
		expect(chart.options().accessibility.keyBindings.next).toEqual(['ArrowRight', 'ArrowUp', 'Alt+[KeyN]']);
		expect(chart.options().accessibility.keyBindings.refresh).toEqual([]);
		expect(hint.textContent).toContain('Alt/Option+[KeyN]');
		expect(hint.textContent).not.toContain('Command/Meta+K');
	});

	it('rejects conflicting bindings before mounting or changing any live options', async () => {
		t = new TestChart({ accessibility: { label: 'Prices', keyBindings: { refresh: ['Cmd+r'] } } });
		const { chart } = t;
		const container = document.createElement('div');
		expect(() => createChart(container, { accessibility: { keyBindings: { next: ['Home'] } } })).toThrow(/Home/);
		expect(container.childElementCount).toBe(0);
		expect(() =>
			chart.applyOptions({
				theme: 'dark',
				accessibility: { label: 'Other', keyBindings: { fitContent: ['Meta+R'] } },
			}),
		).toThrow(/Meta\+R/);
		chart.applyOptions({ height: 300 });
		expect(chart.theme()).toBe('light');
		expect(chart.element().getAttribute('aria-label')).toBe('Prices');
		const slider = chart.element().querySelector('input')!;
		expect(press(slider, 'r', { metaKey: true })).toBe(false);
		chart.addSeries('candlestick').setData(candles(10));
		await t.settle();
		slider.focus();
		expect(press(slider, 'r', { metaKey: true })).toBe(true);
	});

	it('keeps a live quote quiet until explicitly refreshed and preserves focus through empty data', async () => {
		t = new TestChart();
		const chart = t.chart,
			root = chart.element(),
			slider = root.querySelector('input')!,
			status = root.querySelector('[role=status]')!;
		const series = chart.addSeries('line', { id: 'Quote', precision: 2 });
		series.setData([{ time: MINUTE, value: 111 }]);
		await t.settle();
		expect(status.textContent).toBe('');
		slider.focus();
		const snapshot = status.textContent;
		expect(snapshot).toContain('Quote line, 111.00');
		series.update({ time: MINUTE, value: 188 });
		await t.settle();
		expect(status.textContent).toBe(snapshot);
		press(slider, 'Enter');
		expect(status.textContent).toContain('Quote line, 188.00');
		series.setData([{ time: MINUTE, value: 166 }]);
		await t.settle();
		expect(status.textContent).toContain('Quote line, 166.00');
		series.setData([]);
		await t.settle();
		expect(document.activeElement).toBe(slider);
		expect(slider.getAttribute('aria-disabled')).toBe('true');
		series.setData([{ time: 0, value: 7 }]);
		await t.settle();
		expect(status.textContent).toContain('Quote line, 7.00');
		slider.blur();
		expect(status.textContent).toBe('');
	});

	it('keeps the selected time on prepend and accepts native adjustments at either end', async () => {
		t = new TestChart();
		const chart = t.chart,
			root = chart.element(),
			slider = root.querySelector('input')!,
			status = root.querySelector('[role=status]')!;
		const series = chart.addSeries('candlestick', { id: 'Prices' });
		series.setData(candles(100, 100));
		await t.settle();
		slider.focus();
		press(slider, 'Home');
		await t.settle();
		expect(status.textContent).toContain('Bar 1. 1970-01-01 01:40');
		series.prepend(candles(50, 50));
		await t.settle();
		expect(status.textContent).toContain('Bar 51. 1970-01-01 01:40');
		slider.value = '1';
		slider.dispatchEvent(new Event('input'));
		await t.settle();
		expect(status.textContent).toContain('Bar 1. 1970-01-01 00:50');
	});

	it('uses the native input event and distinguishes aggregates, indicator outputs and missing data', async () => {
		t = new TestChart();
		const chart = t.chart,
			slider = chart.element().querySelector('input')!;
		const source = chart.addSeries('candlestick', { id: 'ABC' });
		source.setData(candles(50000));
		const sma = chart.addIndicator(source, 'sma', { id: 'average', params: { period: 2 } });
		chart.timeScale().fitContent();
		await t.settle();
		expect(Number(slider.max)).toBeLessThan(50000);
		slider.value = '2';
		slider.dispatchEvent(new Event('input', { bubbles: true }));
		await t.settle();
		expect(chart.element().querySelector('[role=status]')!.textContent).toContain('(aggregated)');
		expect(chart.element().querySelector('[role=status]')!.textContent).toContain('average sma');
		expect(slider.value).toBe('2');
		chart.removeIndicator(sma);
		source.setData([]);
		await t.settle();
		expect(chart.element().querySelector('[role=status]')!.textContent).toBe('No chart data.');
	});
});
