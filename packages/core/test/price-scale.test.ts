import { describe, expect, it } from 'vitest';
import { PriceScale, niceStep } from '../src/model/price-scale';

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
			const price = ps.tickPrices[i]!;
			expect(price % 10).toBe(0);
			const y = ps.priceToY(price);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(500);
			expect(ps.tickLabels[i]).toBe(price.toFixed(2));
			const previousY = i > 0 ? ps.priceToY(ps.tickPrices[i - 1]!) : Infinity;
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
