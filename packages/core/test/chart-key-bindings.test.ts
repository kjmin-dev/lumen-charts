import { describe, expect, it } from 'vitest';
import { ChartKeymap, defaultChartKeymap } from '../src/input/chart-key-bindings';

function key(value: string, options: KeyboardEventInit = {}) {
	return new KeyboardEvent('keydown', { key: value, cancelable: true, ...options });
}

describe('navigator key bindings', () => {
	it('normalizes modifier aliases and matches only the full chord', () => {
		const keys = new ChartKeymap({ next: ['command+SHIFT+k', 'shift+meta+K', 'Option+Control+F8'] });
		expect(keys.bindings.next).toEqual(['ArrowRight', 'ArrowUp', 'Shift+Meta+K', 'Ctrl+Alt+F8']);
		expect(keys.match(key('K', { shiftKey: true, metaKey: true }))).toBe('next');
		expect(keys.match(key('k', { metaKey: true }))).toBeUndefined();
		expect(keys.match(key('K', { shiftKey: true, metaKey: true, altKey: true }))).toBeUndefined();

		const ctrlAlt = key('F8', { ctrlKey: true, altKey: true });
		// A function key cannot produce AltGr text, even on browsers reporting Ctrl+Alt as AltGraph.
		expect(keys.match(ctrlAlt)).toBe('next');
		Object.defineProperty(ctrlAlt, 'getModifierState', { value: () => false });
		expect(keys.match(ctrlAlt)).toBe('next');
	});

	it('matches produced characters and falls back to the physical key on other layouts', () => {
		const keys = new ChartKeymap({ next: ['Option+[KeyJ]'], previous: ['Alt+j'], refresh: ['Ctrl++', 'Space'] });
		expect(keys.match(key('∆', { code: 'KeyJ', altKey: true }))).toBe('next');
		expect(keys.match(key('j', { code: 'KeyJ', altKey: true }))).toBe('previous');
		expect(keys.match(key('+', { ctrlKey: true }))).toBe('refresh');
		expect(keys.match(key(' '))).toBe('refresh');
		expect(defaultChartKeymap.match(key('+', { shiftKey: true }))).toBe('zoomIn');
		expect(defaultChartKeymap.match(key('0', { shiftKey: true }))).toBe('fitContent');
	});

	it('leaves composition, AltGr text, cancelled events and Tab traversal alone', () => {
		const keys = new ChartKeymap({ next: ['Alt+Ctrl+[KeyJ]', 'Shift+[KeyJ]', '[KeyJ]'] });
		expect(keys.match(key('j', { code: 'KeyJ', ctrlKey: true, altKey: true }))).toBeUndefined();
		expect(keys.match(key('j', { code: 'KeyJ', isComposing: true }))).toBeUndefined();
		expect(keys.match(key('Dead', { code: 'KeyJ' }))).toBeUndefined();
		expect(keys.match(key('Tab', { shiftKey: true, code: 'KeyJ' }))).toBeUndefined();
		const cancelled = key('j', { code: 'KeyJ' });
		cancelled.preventDefault();
		expect(keys.match(cancelled)).toBeUndefined();
	});

	it.each(['Shift+Tab', '[Tab]', 'Alt', 'Shift+[ControlLeft]', 'Ctrl+Control+F', 'Ctrl+', 'Fn+x', '', '[KeyJ'])(
		'rejects the reserved or malformed chord %j',
		value => expect(() => new ChartKeymap({ refresh: [value] })).toThrow(RangeError),
	);
});
