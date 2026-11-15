import { describe, expect, it } from 'vitest';
import { mergeOptions, optionsEqual, resolveOptions, themes } from '../src/options';
import { dashPattern, isFaint, textColorOn } from '../src/render/chrome';

describe('resolveOptions', () => {
	it('lays the theme over the defaults and what was set over the theme', () => {
		const light = resolveOptions({}, false);
		expect(light.theme).toBe('light');
		expect(light.layout.background).toBe(themes.light.layout.background);
		expect(light.layout.fontSize).toBe(12);

		const dark = resolveOptions({ theme: 'dark', grid: { horzLines: { color: '#ff00ff' } } }, false);
		expect(dark.layout.background).toBe(themes.dark.layout.background);
		expect(dark.crosshair.vertLine.labelBackgroundColor).toBe(themes.dark.crosshair.vertLine.labelBackgroundColor);
		expect(dark.grid.vertLines.color).toBe(themes.dark.grid.vertLines.color);
		expect(dark.grid.horzLines.color).toBe('#ff00ff');
		// Values a theme doesn't set are the same in every theme.
		expect(dark.grid.horzLines.visible).toBe(true);
		expect(dark.crosshair.vertLine.style).toBe('dashed');
	});

	it('resolves auto to the system scheme', () => {
		expect(resolveOptions({ theme: 'auto' }, true).layout.background).toBe(themes.dark.layout.background);
		expect(resolveOptions({ theme: 'auto' }, false).layout.background).toBe(themes.light.layout.background);
		expect(resolveOptions({ theme: 'auto' }, true).theme).toBe('auto');
	});

	it('ignores keys and shapes the options do not have', () => {
		const options = resolveOptions(
			{ background: '#123456', layout: 'red', grid: { vertLines: { visible: false, extra: 1 } } } as never,
			false,
		);
		expect('background' in options).toBe(false);
		expect(options.layout.background).toBe(themes.light.layout.background);
		expect(options.grid.vertLines.visible).toBe(false);
		expect('extra' in options.grid.vertLines).toBe(false);
	});
});

const worker = (): Worker => ({}) as Worker;

describe('mergeOptions', () => {
	it('merges nested values, skips undefined and copies what it takes', () => {
		const patch = { layout: { textColor: '#111111' } };
		const merged = mergeOptions<Record<string, unknown>>({ layout: { background: '#000000' }, width: 1 }, {
			...patch,
			width: undefined,
		} as never);
		expect(merged).toEqual({ layout: { background: '#000000', textColor: '#111111' }, width: 1 });
		patch.layout.textColor = '#222222';
		expect((merged.layout as { textColor: string }).textColor).toBe('#111111');
	});

	it('keeps functions as they are', () => {
		expect(mergeOptions({ worker: true as boolean | (() => Worker) }, { worker }).worker).toBe(worker);
	});
});

describe('optionsEqual', () => {
	it('compares nested objects by value', () => {
		expect(optionsEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
		expect(optionsEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
		expect(optionsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
	});
});

describe('dashPattern', () => {
	it('scales with the unit and shares arrays', () => {
		expect(dashPattern('solid', 2)).toEqual([]);
		expect(dashPattern('dotted', 1)).toEqual([1, 2]);
		expect(dashPattern('dashed', 2)).toEqual([6, 6]);
		expect(dashPattern('dashed', 2)).toBe(dashPattern('dashed', 2.2));
	});
});

describe('textColorOn', () => {
	/** A context that reports colors the way browsers do for these inputs: unchanged. */
	const ctx = { fillStyle: '' } as unknown as CanvasRenderingContext2D;

	it('picks dark text on light colors and white text on dark ones', () => {
		expect(textColorOn(ctx, '#ffffff')).toBe('#0e1116');
		expect(textColorOn(ctx, '#f5b83d')).toBe('#0e1116');
		expect(textColorOn(ctx, 'rgba(255, 255, 0, 1)')).toBe('#0e1116');
		expect(textColorOn(ctx, '#000000')).toBe('#ffffff');
		expect(textColorOn(ctx, '#ef5350')).toBe('#ffffff');
		expect(textColorOn(ctx, '#2962ff')).toBe('#ffffff');
		expect(textColorOn(ctx, '#26a69a')).toBe('#ffffff');
		expect(textColorOn(ctx, '#ff9800')).toBe('#0e1116');
		// Colors it cannot read get white text.
		expect(textColorOn(ctx, 'color(display-p3 1 1 1)')).toBe('#ffffff');
	});

	it('tells faint colors from opaque ones', () => {
		expect(isFaint(ctx, 'rgba(0, 0, 0, 0)')).toBe(true);
		expect(isFaint(ctx, 'rgba(38, 166, 154, 0.2)')).toBe(true);
		expect(isFaint(ctx, 'rgba(38, 166, 154, 0.8)')).toBe(false);
		expect(isFaint(ctx, '#26a69a')).toBe(false);
		expect(isFaint(ctx, 'color(display-p3 1 1 1)')).toBe(false);
	});
});
