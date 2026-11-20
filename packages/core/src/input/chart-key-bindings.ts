const actions = {
	previous: { label: 'inspect the previous sample', navigation: ['ArrowLeft', 'ArrowDown'] },
	next: { label: 'inspect the next sample', navigation: ['ArrowRight', 'ArrowUp'] },
	pageBackward: { label: 'move back one view', navigation: ['PageDown'] },
	pageForward: { label: 'move forward one view', navigation: ['PageUp'] },
	first: { label: 'inspect the first sample', navigation: ['Home'] },
	last: { label: 'inspect the last sample', navigation: ['End'] },
	zoomIn: { label: 'zoom in', shortcuts: ['Plus', 'Shift+Plus', '=', 'Shift+='] },
	zoomOut: { label: 'zoom out', shortcuts: ['-', 'Shift+-'] },
	fitContent: { label: 'fit all data', shortcuts: ['0', 'Shift+0'] },
	refresh: { label: 'refresh the reading', shortcuts: ['Enter'] },
} as const;

/** Actions available while the chart's data navigator has focus. */
export type ChartKeyboardAction = keyof typeof actions;
/** Per-action alternatives accepted by createChart and applyOptions. */
export type ChartKeyBindings = Partial<Record<ChartKeyboardAction, readonly string[]>>;

const modifiers = [
	{ name: 'Ctrl', flag: 'ctrlKey', aliases: ['ctrl', 'control'] },
	{ name: 'Alt', flag: 'altKey', aliases: ['alt', 'option'] },
	{ name: 'Shift', flag: 'shiftKey', aliases: ['shift'] },
	{ name: 'Meta', flag: 'metaKey', aliases: ['meta', 'cmd', 'command'] },
] as const;

const modifierAliases = new Map<string, string>();
for (const modifier of modifiers) {
	for (const alias of modifier.aliases) modifierAliases.set(alias, modifier.name);
}
const reserved =
	/^(?:Tab|Shift|Alt|Control|Meta|OS|AltGraph|CapsLock|NumLock|ScrollLock|Fn|FnLock|Symbol|SymbolLock|Super|Hyper|Dead|Compose|Process|Unidentified)$/i;

function keyName(key: string): string {
	if (key === '+' || key === 'Plus') return 'Plus';
	if (key === ' ' || key === 'Space') return 'Space';
	return /^[a-z]$/.test(key) ? key.toUpperCase() : key;
}

/** Canonical chord spelling is also the lookup key and the text shown in the navigator. */
function parseChord(value: string): string {
	const invalid = () => new RangeError('lumen-charts: invalid navigator key binding ' + JSON.stringify(value));
	if (typeof value !== 'string') throw invalid();
	// A final plus is a key, including in "Ctrl++". "Plus" is equivalent.
	const parts = value
		.trim()
		.replace(/(^|\+)\+$/, '$1Plus')
		.split('+')
		.map(s => s.trim());
	const key = parts.pop()!;
	const pressed = new Set<string>();
	for (const part of parts) {
		const name = modifierAliases.get(part.toLowerCase());
		if (!name || pressed.has(name)) throw invalid();
		pressed.add(name);
	}
	const physical = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(key);
	const base = physical?.[1] ?? key;
	if (!base || reserved.test(base) || modifierAliases.has(base.toLowerCase())) throw invalid();
	if (physical && /^(?:Alt|Control|Shift|Meta|OS)(?:Left|Right)$/.test(base)) throw invalid();
	if (!physical && Array.from(base).length !== 1 && !/^[A-Z][a-zA-Z0-9]*$/.test(base)) throw invalid();
	let prefix = '';
	for (const { name } of modifiers) {
		if (pressed.has(name)) prefix += name + '+';
	}
	return prefix + (physical ? key : keyName(key));
}

export class ChartKeymap {
	public readonly bindings: Required<ChartKeyBindings>;
	public readonly instructions: string;
	private readonly chords = new Map<string, ChartKeyboardAction>();

	public constructor(overrides: ChartKeyBindings = {}) {
		if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
			throw new RangeError('lumen-charts: expected a navigator key binding map');
		const bindings = {} as Required<ChartKeyBindings>;
		const hints: string[] = [];
		for (const action of Object.keys(actions) as ChartKeyboardAction[]) {
			const definition = actions[action];
			const extra = overrides[action];
			if (extra !== undefined && !Array.isArray(extra))
				throw new RangeError('lumen-charts: expected a key binding array for ' + action);
			// Preserve the native range keys. Other shortcuts belong to the application once configured.
			const keys =
				'navigation' in definition ? [...definition.navigation, ...(extra ?? [])] : (extra ?? definition.shortcuts);
			const names = new Set<string>();
			for (const key of keys) {
				const chord = parseChord(key);
				const owner = this.chords.get(chord);
				if (owner && owner !== action)
					throw new RangeError('lumen-charts: ' + chord + ' is bound to both ' + owner + ' and ' + action);
				this.chords.set(chord, action);
				names.add(chord);
			}
			bindings[action] = Object.freeze([...names]);
			if (names.size) {
				const labels = [...names].map(name => name.replace('Meta+', 'Command/Meta+').replace('Alt+', 'Alt/Option+'));
				hints.push('Press ' + labels.join(' or ') + ' to ' + definition.label + '.');
			}
		}
		this.bindings = Object.freeze(bindings);
		this.instructions = hints.join(' ');
	}

	public match(event: KeyboardEvent): ChartKeyboardAction | undefined {
		if (event.defaultPrevented || event.isComposing || reserved.test(event.key)) return;
		// AltGr may produce text with Ctrl+Alt or with neither flag. Firefox on macOS
		// also reports AltGraph for Option alone, which is a bindable Alt chord.
		if (event.getModifierState('AltGraph') && (!event.altKey || (event.ctrlKey && [...event.key].length === 1))) return;
		let prefix = '';
		for (const { name, flag } of modifiers) {
			if (event[flag]) prefix += name + '+';
		}
		return this.chords.get(prefix + keyName(event.key)) ?? this.chords.get(prefix + '[' + event.code + ']');
	}
}

export const defaultChartKeymap = new ChartKeymap();
