import { describe, expect, it } from 'vitest';
import { PriceScale, decimalsOf, niceStep } from '../src/model/price-scale';
import type { PriceScaleMode } from '../src/options';

/** A scale 500 pixels high in `mode`, fitted to the values of prices 50 to 200 with base 100. */
function scaleFor(mode: PriceScaleMode, inverted = false): PriceScale {
	const ps = new PriceScale('test');
	ps.setHeight(500);
	ps.setMode(mode);
	ps.setInverted(inverted);
	ps.base = 100;
	ps.setRange(ps.toValue(50), ps.toValue(200));
	return ps;
}

const MODES: PriceScaleMode[] = ['normal', 'logarithmic', 'percentage', 'indexed'];

/** Whether a positive number has at most two significant digits (1, 2.5, 40, 0.012, ...). */
function round(value: number): boolean {
	const scaled = value / 10 ** (Math.floor(Math.log10(value)) - 1);
	return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

describe('PriceScale', () => {
	it('maps the range between the margins and back', () => {
		const ps = new PriceScale();
		ps.setHeight(500);
		ps.setRange(100, 200);
		expect(ps.priceToY(200)).toBeCloseTo(50, 9);
		expect(ps.priceToY(100)).toBeCloseTo(450, 9);
		expect(ps.yToPrice(ps.priceToY(137.5))).toBeCloseTo(137.5, 9);
		expect(ps.offset - 137.5 * ps.scale).toBeCloseTo(ps.priceToY(137.5), 9);
	});

	it('takes its margins as fractions of the height, keeping room for the prices', () => {
		const ps = new PriceScale();
		ps.setHeight(100);
		ps.setRange(0, 10);
		ps.setMargins(0.2, 0.3);
		expect(ps.priceToY(10)).toBeCloseTo(20, 9);
		expect(ps.priceToY(0)).toBeCloseTo(70, 9);
		const version = ps.version;
		ps.setMargins(0.2, 0.3);
		expect(ps.version).toBe(version);
		// Margins that would cover the pane are scaled down to 95% together.
		ps.setMargins(0.8, 0.8);
		expect(ps.priceToY(10)).toBeCloseTo(47.5, 9);
		expect(ps.priceToY(0)).toBeCloseTo(52.5, 9);
		ps.setMargins(-1, Number.NaN);
		expect(ps.priceToY(10)).toBeCloseTo(0, 9);
		expect(ps.priceToY(0)).toBeCloseTo(100, 9);
	});

	it('widens a flat range', () => {
		const ps = new PriceScale();
		ps.setHeight(500);
		ps.setRange(50, 50);
		expect(ps.min).toBeLessThan(50);
		expect(ps.max).toBeGreaterThan(50);
		expect(Number.isFinite(ps.priceToY(50))).toBe(true);
	});

	it('ignores an empty range', () => {
		const ps = new PriceScale();
		ps.setHeight(500);
		ps.setRange(1, 2);
		const version = ps.version;
		ps.setRange(Infinity, -Infinity);
		ps.setRange(NaN, NaN);
		ps.setRange(1, 2);
		expect(ps.version).toBe(version);
	});

	it('picks round steps', () => {
		expect(niceStep(0.7)).toBe(1);
		expect(niceStep(1.2)).toBe(2);
		expect(niceStep(3)).toBe(5);
		expect(niceStep(7)).toBe(10);
		expect(niceStep(0.03)).toBeCloseTo(0.05, 12);
		expect(niceStep(0)).toBe(1);
	});

	it('places ticks on multiples of the step, inside the pane', () => {
		const ps = new PriceScale();
		ps.setHeight(500);
		ps.setRange(100, 200);
		ps.updateTicks(40);
		expect(ps.tickCount).toBeGreaterThan(3);
		for (let i = 0; i < ps.tickCount; i++) {
			const price = ps.tickValues[i]!;
			expect(price % 10).toBe(0);
			const y = ps.priceToY(price);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(500);
			expect(ps.tickLabels[i]).toBe(price.toFixed(2));
			const previousY = i > 0 ? ps.priceToY(ps.tickValues[i - 1]!) : Infinity;
			expect(previousY - y).toBeGreaterThanOrEqual(40);
		}
	});

	it('uses as many decimals as the step needs', () => {
		const ps = new PriceScale();
		ps.setHeight(500);
		ps.setRange(1.0001, 1.0009);
		ps.updateTicks(40);
		expect(ps.decimals).toBe(4);
		expect(ps.tickLabels[0]).toMatch(/^1\.\d{4}$/);
	});

	it('recomputes ticks only when the scale changes', () => {
		const ps = new PriceScale();
		ps.setHeight(500);
		ps.setRange(100, 200);
		ps.updateTicks(40);
		ps.tickLabels[0] = 'kept';
		ps.updateTicks(40);
		expect(ps.tickLabels[0]).toBe('kept');
		ps.setRange(100, 300);
		ps.updateTicks(40);
		expect(ps.tickLabels[0]).not.toBe('kept');
	});
});

describe('PriceScale modes', () => {
	for (const mode of MODES) {
		for (const inverted of [false, true]) {
			it(`converts prices to coordinates and back (${mode}${inverted ? ', inverted' : ''})`, () => {
				const ps = scaleFor(mode, inverted);
				for (const price of [50, 63.25, 99.99, 100, 137.5, 200, 250]) {
					const y = ps.priceToY(price);
					expect(Number.isFinite(y)).toBe(true);
					expect(ps.yToPrice(y)).toBeCloseTo(price, 9);
					// The linear form the series views use, on values.
					expect(ps.offset - ps.toValue(price) * ps.scale).toBeCloseTo(y, 9);
					expect(ps.fromValue(ps.toValue(price))).toBeCloseTo(price, 9);
				}
				// Margins of 10% at both ends: the range ends land on them, the low end at the bottom
				// unless inverted.
				const [low, high] = inverted ? [50, 200] : [200, 50];
				expect(ps.priceToY(low)).toBeCloseTo(50, 9);
				expect(ps.priceToY(high)).toBeCloseTo(450, 9);
				expect(ps.scale < 0).toBe(inverted);
				// A base of its own moves a price on percentage and indexed scales only.
				const other = ps.priceToY(150, 120);
				expect(ps.yToPrice(other, 120)).toBeCloseTo(150, 9);
				expect(other === ps.priceToY(150)).toBe(mode === 'normal' || mode === 'logarithmic');
			});
		}
	}

	it('gives the values of each mode', () => {
		expect(scaleFor('normal').toValue(150)).toBe(150);
		expect(scaleFor('logarithmic').toValue(1000)).toBeCloseTo(3, 12);
		expect(scaleFor('percentage').toValue(150)).toBeCloseTo(50, 12);
		expect(scaleFor('percentage').toValue(100)).toBe(0);
		expect(scaleFor('indexed').toValue(150)).toBeCloseTo(150, 12);
		expect(scaleFor('indexed').toValue(100)).toBe(100);
		// A negative base: a rise is still a positive change.
		expect(scaleFor('percentage').toValue(-50, -100)).toBeCloseTo(50, 12);
	});

	it('cannot show prices at or below zero on a logarithmic scale, nor any price without a base', () => {
		const log = scaleFor('logarithmic');
		expect(log.priceToY(0)).toBeNaN();
		expect(log.priceToY(-5)).toBeNaN();
		const percent = scaleFor('percentage');
		expect(percent.priceToY(100, Number.NaN)).toBeNaN();
		expect(Number.isFinite(percent.priceToY(100, 0))).toBe(false);
	});

	it('gives equal ratios equal distances on a logarithmic scale', () => {
		const ps = scaleFor('logarithmic');
		const tenToTwenty = ps.priceToY(10) - ps.priceToY(20);
		expect(ps.priceToY(100) - ps.priceToY(200)).toBeCloseTo(tenToTwenty, 9);
		expect(ps.priceToY(1000) - ps.priceToY(2000)).toBeCloseTo(tenToTwenty, 9);
	});

	it('fits again after a change of mode, and refuses ranges that cannot be drawn', () => {
		const ps = scaleFor('normal');
		expect(ps.hasRange).toBe(true);
		const version = ps.version;
		ps.setMode('percentage');
		expect(ps.hasRange).toBe(false);
		expect(ps.version).toBeGreaterThan(version);
		ps.setRange(-10, Infinity);
		ps.setRange(Number.NaN, 5);
		expect(ps.hasRange).toBe(false);
		ps.setRange(-10, 20);
		expect(ps.hasRange).toBe(true);
	});

	it('zooms around the middle and scrolls with the pointer', () => {
		const ps = scaleFor('normal');
		ps.zoom(2);
		expect(ps.min).toBeCloseTo(-25, 9);
		expect(ps.max).toBeCloseTo(275, 9);
		// Dragging down by 40 pixels moves what was at y to y + 40.
		const y = ps.priceToY(120);
		ps.scrollBy(40);
		expect(ps.priceToY(120)).toBeCloseTo(y + 40, 9);
		const inverted = scaleFor('normal', true);
		const before = inverted.priceToY(120);
		inverted.scrollBy(-25);
		expect(inverted.priceToY(120)).toBeCloseTo(before - 25, 9);
		// Factors that would collapse or blow up the range are ignored.
		const { min, max } = ps;
		ps.zoom(0);
		ps.zoom(Infinity);
		ps.zoom(1e-300);
		expect([ps.min, ps.max]).toEqual([min, max]);
	});
});

/** Tick rows, top to bottom, checked to lie in the pane at least `spacing` apart. */
function rows(ps: PriceScale, spacing: number): number[] {
	const ys: number[] = [];
	for (let i = 0; i < ps.tickCount; i++) {
		ys.push(ps.valueToY(ps.tickValues[i]!));
	}
	ys.sort((a, b) => a - b);
	for (const y of ys) {
		expect(y).toBeGreaterThanOrEqual(-1e-6);
		expect(y).toBeLessThanOrEqual(ps.height + 1e-6);
	}
	for (let i = 1; i < ys.length; i++) {
		expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(spacing - 1e-6);
	}
	return ys;
}

describe('PriceScale ticks', () => {
	it('puts the ticks of a logarithmic scale on round prices, about evenly spaced', () => {
		const ps = scaleFor('logarithmic');
		ps.updateTicks(40);
		expect(ps.tickCount).toBeGreaterThan(4);
		rows(ps, 40);
		for (let i = 0; i < ps.tickCount; i++) {
			const price = 10 ** ps.tickValues[i]!;
			expect(round(price)).toBe(true);
			expect(Number(ps.tickLabels[i])).toBeCloseTo(price, 6);
		}
	});

	it('steps through decades on a wide logarithmic scale', () => {
		const ps = new PriceScale();
		ps.setHeight(400);
		ps.setMode('logarithmic');
		ps.setRange(-2, 8);
		ps.updateTicks(32);
		const prices = Array.from(ps.tickValues.subarray(0, ps.tickCount), value => 10 ** value);
		expect(prices.length).toBeGreaterThanOrEqual(6);
		rows(ps, 32);
		// Every tick is a power of ten.
		for (const price of prices) {
			expect(Math.log10(price)).toBeCloseTo(Math.round(Math.log10(price)), 9);
		}
		expect(ps.tickLabels[0]).toBe('0.01');
	});

	it('looks like a linear scale where a logarithmic one spans little', () => {
		const ps = new PriceScale();
		ps.setHeight(500);
		ps.setMode('logarithmic');
		ps.setRange(Math.log10(100), Math.log10(102));
		ps.updateTicks(40);
		const prices = Array.from(ps.tickValues.subarray(0, ps.tickCount), value => 10 ** value);
		expect(prices.length).toBeGreaterThan(4);
		const steps = prices.slice(1).map((price, i) => price - prices[i]!);
		for (const step of steps) {
			expect(step).toBeCloseTo(steps[0]!, 6);
		}
		// 40 pixels are a little over 0.2 near the top, so the step is the next round one.
		expect(steps[0]).toBeCloseTo(0.5, 9);
		rows(ps, 40);
	});

	it('labels percentage ticks in percent and indexed ones as numbers', () => {
		const percent = scaleFor('percentage');
		percent.updateTicks(40);
		rows(percent, 40);
		expect(percent.tickLabels.slice(0, percent.tickCount)).toContain('0.00%');
		const indexed = scaleFor('indexed');
		indexed.updateTicks(40);
		expect(indexed.tickLabels.slice(0, indexed.tickCount)).toContain('100.00');
		for (const mode of MODES) {
			const inverted = scaleFor(mode, true);
			inverted.updateTicks(40);
			expect(inverted.tickCount).toBeGreaterThan(3);
			rows(inverted, 40);
		}
	});

	it('puts ticks on multiples of the tick size with its decimals', () => {
		const ps = new PriceScale();
		ps.setHeight(500);
		ps.setRange(100, 102);
		ps.setFormat(0.25, -1);
		ps.updateTicks(40);
		expect(ps.tickCount).toBeGreaterThan(3);
		for (let i = 0; i < ps.tickCount; i++) {
			const value = ps.tickValues[i]!;
			expect(value / 0.25).toBeCloseTo(Math.round(value / 0.25), 9);
			expect(ps.tickLabels[i]).toMatch(/^\d+\.\d\d$/);
		}
		// A tick size coarser than the spacing asks for: every tick, no finer.
		ps.setFormat(5, -1);
		ps.setRange(100, 120);
		ps.updateTicks(40);
		expect(ps.tickLabels.slice(0, ps.tickCount)).toEqual(['100', '105', '110', '115', '120']);
		// More decimals than the tick size has.
		ps.setFormat(5, 3);
		ps.updateTicks(40);
		expect(ps.tickLabels[0]).toBe('100.000');
	});

	it('labels only the band of the pane a scale with wide margins fills', () => {
		for (const mode of ['normal', 'logarithmic'] as const) {
			const ps = new PriceScale();
			ps.setHeight(400);
			ps.setMode(mode);
			ps.setMargins(0.75, 0);
			ps.setRange(ps.toValue(30), ps.toValue(70));
			ps.updateTicks(40);
			expect(ps.tickCount).toBeGreaterThanOrEqual(2);
			for (const y of rows(ps, 40)) {
				// The band is the lowest quarter; ticks reach at most one spacing above it.
				expect(y).toBeGreaterThanOrEqual(100 - 40 - 1e-6);
			}
		}
	});

	it('changes the generation of the ticks only when they are recomputed or cleared', () => {
		const ps = scaleFor('normal');
		ps.updateTicks(40);
		const generation = ps.ticksGeneration;
		ps.updateTicks(40);
		ps.setFormat(0, -1);
		expect(ps.ticksGeneration).toBe(generation);
		ps.clearTicks();
		expect(ps.tickCount).toBe(0);
		expect(ps.ticksGeneration).toBe(generation + 1);
		ps.clearTicks();
		expect(ps.ticksGeneration).toBe(generation + 1);
		ps.updateTicks(40);
		expect(ps.tickCount).toBeGreaterThan(0);
	});
});

describe('PriceScale formats', () => {
	it('rounds prices to the tick size and shows its decimals', () => {
		const ps = scaleFor('normal');
		expect(ps.formatPrice(101.13, 0.25, -1)).toBe('101.25');
		expect(ps.formatPrice(101.1, 0.5, -1)).toBe('101.0');
		expect(ps.formatPrice(1.234567, 0.0001, -1)).toBe('1.2346');
		expect(ps.formatPrice(1234.4, 5, -1)).toBe('1235');
		expect(ps.formatPrice(1234.4, 5, 2)).toBe('1235.00');
		expect(ps.formatPrice(101.126, 0, 1)).toBe('101.1');
		// Without a format, the decimals of the ticks.
		expect(ps.formatPrice(101.126)).toBe(`${(101.126).toFixed(ps.decimals)}`);
		// No sign on a value that rounds to zero.
		expect(ps.formatPrice(-0.0001)).toBe('0.00');
	});

	it('formats a price as each mode shows it', () => {
		expect(scaleFor('normal').format(150)).toBe('150.00');
		expect(scaleFor('logarithmic').format(150)).toBe('150.00');
		expect(scaleFor('percentage').format(150)).toBe('50.00%');
		expect(scaleFor('percentage').format(99.999)).toBe('0.00%');
		expect(scaleFor('percentage').format(75, 50)).toBe('50.00%');
		expect(scaleFor('indexed').format(150)).toBe('150.00');
		expect(scaleFor('logarithmic').formatValue(2)).toBe('100.00');
	});

	it('counts the decimals of a tick size', () => {
		expect(decimalsOf(0.25)).toBe(2);
		expect(decimalsOf(0.001)).toBe(3);
		expect(decimalsOf(0.00001)).toBe(5);
		expect(decimalsOf(5)).toBe(0);
		expect(decimalsOf(0.1 + 0.2)).toBe(1);
	});

	it('changes the format version only when a label of the same price could change', () => {
		const ps = scaleFor('normal');
		const version = ps.formatVersion;
		ps.setFormat(0, -1);
		expect(ps.formatVersion).toBe(version);
		ps.setFormat(0.5, -1);
		expect(ps.formatVersion).toBe(version + 1);
		ps.setMode('percentage');
		expect(ps.formatVersion).toBe(version + 2);
	});
});
