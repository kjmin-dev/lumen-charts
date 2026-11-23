// The JSON the benchmarks store. Free of DOM and Node APIs, so the manual page writes it too.

/** Columns a value may take on its line, tabs of its indentation counted as one, before it is spread. */
export const JSON_WIDTH = 240;

/**
 * `value` as JSON, ending in a newline: a value that fits `width` columns on its line stays on one
 * line, and so does a list of plain values (numbers, strings, booleans, null) however long; larger
 * objects and lists put one entry on each line, indented by tabs. Parses to what
 * `JSON.stringify(value, null, '\t')` parses to, in a fraction of the lines: results files hold
 * thousands of short fields, which that form puts on a line each.
 */
export function formatJson(value: unknown, width = JSON_WIDTH): string {
	return `${format(value, width, 0) ?? 'null'}\n`;
}

/** Undefined where `JSON.stringify` leaves the value out (undefined, a function or a symbol). */
function format(value: unknown, width: number, depth: number): string | undefined {
	const flat = JSON.stringify(value) as string | undefined;
	if (
		flat === undefined ||
		value === null ||
		typeof value !== 'object' ||
		typeof (value as { toJSON?: unknown }).toJSON === 'function' ||
		flat.length + depth <= width ||
		(Array.isArray(value) && value.every(plain))
	) {
		return flat;
	}
	const inner = '\t'.repeat(depth + 1);
	const lines: string[] = [];
	if (Array.isArray(value)) {
		for (const item of value) {
			lines.push(inner + (format(item, width, depth + 1) ?? 'null'));
		}
	} else {
		for (const [key, item] of Object.entries(value)) {
			const text = format(item, width, depth + 1);
			if (text !== undefined) {
				lines.push(`${inner}${JSON.stringify(key)}: ${text}`);
			}
		}
	}
	if (lines.length === 0) {
		return flat;
	}
	const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
	return `${open}\n${lines.join(',\n')}\n${'\t'.repeat(depth)}${close}`;
}

function plain(value: unknown): boolean {
	return value === null || (typeof value !== 'object' && typeof value !== 'function');
}
