// Counts Canvas 2D drawing calls. Only for diagnostics in untimed passes: the wrappers add a
// function call to every drawing operation.

const COUNTED = ['fillRect', 'strokeRect', 'fill', 'stroke', 'lineTo', 'fillText', 'drawImage'] as const;

type Counted = (typeof COUNTED)[number];

/** Runs `action` with every counted method of `CanvasRenderingContext2D` wrapped; returns the counts. */
export async function countDrawCalls(action: () => Promise<void>): Promise<Record<string, number>> {
	const proto = CanvasRenderingContext2D.prototype as unknown as Record<Counted, (...args: unknown[]) => unknown>;
	const counts: Record<string, number> = {};
	const originals = new Map<Counted, (...args: unknown[]) => unknown>();
	for (const name of COUNTED) {
		const original = proto[name];
		originals.set(name, original);
		counts[name] = 0;
		proto[name] = function (this: unknown, ...args: unknown[]): unknown {
			counts[name] = (counts[name] ?? 0) + 1;
			return original.apply(this, args);
		};
	}
	try {
		await action();
	} finally {
		for (const [name, original] of originals) {
			proto[name] = original;
		}
	}
	return counts;
}
