import { describe, expect, it } from 'vitest';
import { formatJson } from '../src/json.ts';

describe('formatJson', () => {
	it('parses to what JSON.stringify gives, leaving out what it leaves out', () => {
		const value = {
			a: 1.5,
			b: 'text',
			c: null,
			d: undefined,
			e: [1, undefined, () => 0, 'x'],
			f: { g: [true, false], h: {} },
			i: new Date(0),
			j: [],
			k: [{ l: undefined }],
		};
		expect(JSON.parse(formatJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
		expect(formatJson(undefined)).toBe('null\n');
	});

	it('keeps a value that fits on one line, and spreads one that does not', () => {
		expect(formatJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}\n');
		const wide = { short: { a: 1 }, long: { text: 'x'.repeat(50), more: 'y'.repeat(50) } };
		expect(formatJson(wide, 60)).toBe(
			`{\n\t"short": {"a":1},\n\t"long": {\n\t\t"text": "${'x'.repeat(50)}",\n\t\t"more": "${'y'.repeat(50)}"\n\t}\n}\n`,
		);
	});

	it('keeps a list of plain values on one line however long', () => {
		const samples = Array.from({ length: 500 }, (_, i) => i / 7);
		const text = formatJson({ samples }, 40);
		expect(text.split('\n')).toHaveLength(4);
		expect(JSON.parse(text)).toEqual({ samples });
	});

	it('spreads a list of objects one entry a line', () => {
		const runs = [{ id: 'a'.repeat(30) }, { id: 'b'.repeat(30) }];
		expect(formatJson({ runs }, 50)).toBe(
			`{\n\t"runs": [\n\t\t{"id":"${'a'.repeat(30)}"},\n\t\t{"id":"${'b'.repeat(30)}"}\n\t]\n}\n`,
		);
	});
});
