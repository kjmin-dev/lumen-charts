// The drawing set of the stage 4 scenarios. Shared by the page and the Node runner, so this module
// must stay free of DOM and Node APIs.

import { type CandleColumns, Random } from './data.ts';

/** The tools every library with drawings is asked for, in the order the set cycles through them. */
export const DRAWING_TOOLS = [
	'trendLine',
	'ray',
	'extendedLine',
	'horizontalLine',
	'verticalLine',
	'rectangle',
	'parallelChannel',
	'fibRetracement',
	'text',
	'priceRange',
] as const;

export type BenchDrawingTool = (typeof DRAWING_TOOLS)[number];

const POINTS: Readonly<Record<BenchDrawingTool, number>> = {
	trendLine: 2,
	ray: 2,
	extendedLine: 2,
	horizontalLine: 1,
	verticalLine: 1,
	rectangle: 2,
	parallelChannel: 3,
	fibRetracement: 2,
	text: 1,
	priceRange: 2,
};

/** A drawing as plain data: a tool, its points as (time, price), and an optional text. */
export interface BenchDrawing {
	readonly type: BenchDrawingTool;
	readonly points: readonly { readonly time: number; readonly price: number }[];
	readonly text?: string;
	/** Whether its time range overlaps the starting view. */
	readonly inView: boolean;
}

/**
 * `count` drawings over the candles, cycling through every tool: half with all points on bars of
 * the view `[viewFrom, viewTo]` (bar indexes), at prices of those bars, the other half in older
 * history, where they are out of view (rays, extended and horizontal lines from there may still
 * cross it). Point spans are a few to a few hundred bars, as people draw them.
 */
export function generateDrawings(
	data: CandleColumns,
	count: number,
	viewFrom: number,
	viewTo: number,
	seed: number,
): BenchDrawing[] {
	const random = new Random(seed);
	const drawings: BenchDrawing[] = [];
	const visible = viewTo - viewFrom + 1;
	const n = data.length;
	const pick = (from: number, to: number): number => from + Math.floor(random.next() * Math.max(1, to - from));
	for (let i = 0; i < count; i++) {
		const type = DRAWING_TOOLS[i % DRAWING_TOOLS.length]!;
		const inView = i % 2 === 0;
		// Out-of-view drawings sit in the history before the view, at least a view's width away.
		const from = inView ? viewFrom : Math.max(0, viewFrom - 50 * visible);
		const to = inView ? viewTo : Math.max(1, viewFrom - visible);
		const first = pick(from, to);
		const span = 3 + Math.floor(random.next() * Math.min(300, visible / 2));
		const points: { time: number; price: number }[] = [];
		for (let k = 0; k < POINTS[type]; k++) {
			const bar = Math.min(n - 1, Math.min(to, first + Math.floor((k * span) / 2)));
			const low = data.low[bar]!;
			const high = data.high[bar]!;
			points.push({ time: data.time[bar]!, price: low + random.next() * (high - low) * 3 - (high - low) });
		}
		drawings.push({ type, points, inView, ...(type === 'text' ? { text: `Note ${i}` } : {}) });
	}
	return drawings;
}
