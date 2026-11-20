import type { ChartReadout } from './chart-readout';
import type { Crosshair } from '../model/crosshair';
import type { FrameModel } from '../model/frame-model';
import { INVALIDATE_CURSOR, INVALIDATE_LIGHT, type Invalidation } from '../model/invalidation';
import type { TimeScale } from '../model/time-scale';
import type { ChartOptions } from '../options';
import type { ChartLayout } from '../render/layout';

let nextId = 0;
const instructions =
	'Arrow keys move one data point. Page Up and Page Down move one view. Home and End go to the ends. Plus and minus zoom. Zero fits all data. Enter refreshes the reading.';
const clipped =
	'position:absolute;width:1px;height:1px;padding:0;margin:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;';

function stopPropagation(event: Event) {
	event.stopPropagation();
}

function setText(element: HTMLElement, value: string) {
	if (element.textContent !== value) element.textContent = value;
}

/** One native range input per chart. Its units are the rows or buckets actually supplied by the engine. */
export class ChartAccessibility {
	private readonly slider: HTMLInputElement;
	private readonly panel: HTMLElement;
	private readonly summary: HTMLElement;
	private readonly reading: HTMLElement;
	private readonly status: HTMLElement;
	private requested = true;
	private readTime = NaN;
	private readVersion = -1;
	private readPosition = '';
	private focused = false;
	private ownsCrosshair = false;
	/** Main-timeline index, independent of window offsets and level of detail. */
	private index = 0;
	private size = 1;
	private first = NaN;
	private end = NaN;
	private firstBucket = 0;
	private summaryDirty = true;
	private options: ChartOptions['accessibility'] = { label: '', description: '' };

	public constructor(
		private readonly layout: ChartLayout,
		private readonly scale: TimeScale,
		private readonly model: FrameModel,
		private readonly readout: ChartReadout,
		private readonly crosshair: Crosshair,
		private readonly invalidate: (level: Invalidation) => void,
	) {
		const root = layout.root,
			doc = root.ownerDocument;
		const tree = root.getRootNode() as Document | ShadowRoot;
		let id: string;
		do {
			id = 'lumen-data-' + ++nextId;
		} while (tree.getElementById?.(id + '-summary') || tree.getElementById?.(id + '-keys'));
		root.setAttribute('role', 'group');
		this.summary = doc.createElement('p');
		this.summary.id = id + '-summary';
		this.summary.style.cssText = clipped;
		root.setAttribute('aria-describedby', this.summary.id);

		this.panel = doc.createElement('div');
		this.panel.style.cssText =
			'position:absolute;z-index:1;inset-block-start:3px;inset-inline-start:3px;box-sizing:border-box;width:max-content;max-width:min(24rem,calc(100% - 6px));padding:4px 8px;color:CanvasText;background:Canvas;border:2px solid Highlight;font:12px/1.4 system-ui;overflow-wrap:anywhere;pointer-events:none;clip-path:inset(50%);';
		this.slider = doc.createElement('input');
		this.slider.type = 'range';
		this.slider.tabIndex = 0;
		this.slider.dir = 'ltr';
		this.slider.min = '1';
		this.slider.max = '1';
		this.slider.value = '1';
		this.slider.setAttribute('aria-disabled', 'true');
		this.slider.setAttribute('aria-valuetext', 'No chart data.');
		this.summary.textContent = 'No chart data.';
		this.slider.step = '1';
		this.slider.style.cssText = 'display:block;width:10rem;max-width:100%;margin:0;';
		this.reading = doc.createElement('div');
		this.reading.setAttribute('aria-hidden', 'true');
		const hint = doc.createElement('span');
		hint.id = id + '-keys';
		hint.textContent = instructions;
		this.slider.setAttribute('aria-describedby', hint.id + ' ' + this.summary.id);
		this.panel.append(this.slider, this.reading, hint);
		this.status = doc.createElement('p');
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-atomic', 'true');
		this.status.style.cssText = clipped;
		root.append(this.summary, this.panel, this.status);
		this.slider.addEventListener('focus', this.onFocus);
		this.slider.addEventListener('blur', this.onBlur);
		this.slider.addEventListener('keydown', this.onKey);
		this.slider.addEventListener('input', this.onInput);
		// A pointer dragging the focused native control belongs to the slider, not the pane.
		for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick', 'wheel'])
			this.panel.addEventListener(type, stopPropagation);
	}

	public apply(options: ChartOptions['accessibility']) {
		this.options = options;
		const name = options.label.trim() || 'Financial chart';
		this.layout.root.setAttribute('aria-label', name);
		this.slider.setAttribute('aria-label', name + ' data');
		this.summaryDirty = true;
		this.requested = true;
	}
	/** Runs after the model binds series columns and fits axes, before the overlay is painted. */
	public frame() {
		const scale = this.scale;
		const size = 2 ** (this.model.drawn?.shift ?? 0);
		const boundsChanged = this.first !== scale.first || this.end !== scale.end || this.size !== size;
		this.first = scale.first;
		this.end = scale.end;
		this.size = size;
		this.firstBucket = Math.floor(scale.first / this.size);
		const inventoryChanged = this.readout.updateInventory();
		if (inventoryChanged) this.requested = true;
		const summary = this.readout.summary(
			scale.end - scale.first,
			size,
			this.options.description,
			this.summaryDirty || inventoryChanged,
		);
		this.summaryDirty = false;
		if (summary !== null) setText(this.summary, summary);
		if (boundsChanged) {
			const last = Math.floor((scale.end - 1) / this.size);
			this.slider.max = String(Math.max(1, last - this.firstBucket + 1));
			this.slider.setAttribute('aria-disabled', String(scale.isEmpty));
		}
		if (scale.isEmpty) {
			if (boundsChanged) {
				this.slider.value = '1';
				this.requested = true;
				this.setValueText('No chart data.');
				setText(this.reading, 'No chart data.');
				setText(this.status, this.focused ? 'No chart data.' : '');
			}
			this.clearCrosshair();
			return;
		}
		// Track the currently displayed range on external pans and data replacement.
		const firstVisible = Math.max(scale.first, Math.min(scale.end - 1, Math.ceil(scale.from)));
		const lastVisible = Math.max(firstVisible, Math.min(scale.end - 1, Math.floor(scale.to)));
		const index = this.focused ? Math.min(lastVisible, Math.max(firstVisible, this.index)) : lastVisible;
		if (!this.focused && !boundsChanged && index === this.index) return;
		this.index = index;
		this.updateSelection();
	}

	private setValueText(text: string) {
		if (this.slider.getAttribute('aria-valuetext') !== text) this.slider.setAttribute('aria-valuetext', text);
	}

	private updateSelection() {
		const bucket = Math.floor(this.index / this.size);
		const position = String(bucket - this.firstBucket + 1);
		if (this.slider.value !== position) this.slider.value = position;
		const start = Math.max(this.scale.first, bucket * this.size);
		const end = Math.min(this.scale.end, (bucket + 1) * this.size);
		const ordinal = (index: number) => index - this.scale.first + 1;
		const prefix =
			end - start > 1
				? 'Bars ' + ordinal(start) + ' to ' + ordinal(end - 1) + ' (aggregated)'
				: 'Bar ' + ordinal(start);
		this.setValueText(prefix);
		if (!this.focused) return;
		const drawn = this.model.drawn;
		const row = drawn ? bucket - drawn.start : -1;
		const time = drawn?.time[row];
		if (!drawn || drawn.stale || row < 0 || row >= drawn.count || time === undefined || !Number.isFinite(time)) {
			this.requested = true;
			setText(this.status, prefix + '. Data unavailable.');
			setText(this.reading, prefix + '. Data unavailable.');
			this.clearCrosshair();
			return;
		}
		if (this.ownsCrosshair) {
			this.crosshair.x = this.scale.indexToX(this.index);
			this.crosshair.y = this.readout.cursorY(row, this.layout.pixelRatio, this.layout.paneHeight / 2);
			this.crosshair.visible = true;
			this.crosshair.hoverDirty = true;
		}
		// A live tick may change the selected close hundreds of times. Announce a
		// reading on demand or when the selected sample changes, never for each tick.
		if (!this.requested && drawn.version === this.readVersion && time === this.readTime && prefix === this.readPosition)
			return;
		this.requested = false;
		this.readTime = time;
		this.readVersion = drawn.version;
		this.readPosition = prefix;
		const snapshot = this.readout.sample(row, time, prefix, this.size > 1);
		setText(this.reading, snapshot.visible);
		setText(this.status, snapshot.spoken);
	}

	private choose(index: number) {
		const scale = this.scale;
		if (scale.isEmpty || !Number.isFinite(index)) return;
		this.requested = true;
		this.index = Math.max(scale.first, Math.min(scale.end - 1, index));
		this.ownsCrosshair = true;
		const x = scale.indexToX(this.index);
		const inset = Math.min(scale.width / 2, scale.barSpacing / 2);
		const dx = Math.max(inset, Math.min(scale.width - inset, x)) - x;
		if (dx) scale.scrollBy(dx);
		this.updateSelection();
		this.invalidate(dx ? INVALIDATE_LIGHT : INVALIDATE_CURSOR);
	}
	private readonly onInput = () => {
		// Assistive technologies can set a native slider directly, without sending a key.
		const index = (this.firstBucket + Number(this.slider.value) - 1) * this.size;
		if (!this.focused) this.slider.focus({ preventScroll: true });
		this.choose(index);
	};
	private readonly onKey = (event: KeyboardEvent) => {
		if (
			event.defaultPrevented ||
			event.isComposing ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			this.scale.isEmpty
		)
			return;
		const scale = this.scale;
		const step = this.size;
		const bucketStart = Math.floor(this.index / step) * step;
		const page = Math.max(1, Math.floor(scale.width / (scale.barSpacing * step))) * step;
		switch (event.key) {
			case 'ArrowLeft':
			case 'ArrowDown':
				this.choose(bucketStart - step);
				break;
			case 'ArrowRight':
			case 'ArrowUp':
				this.choose(bucketStart + step);
				break;
			case 'PageUp':
				this.choose(bucketStart + page);
				break;
			case 'PageDown':
				this.choose(bucketStart - page);
				break;
			case 'Enter':
				this.choose(this.index);
				break;
			case 'Home':
				this.choose(scale.first);
				break;
			case 'End':
				this.choose(scale.end - 1);
				break;
			case '+':
			case '=':
			case '-':
			case '0':
				this.ownsCrosshair = true;
				if (event.key === '0') scale.fitContent();
				else scale.zoomAt(scale.indexToX(this.index), event.key === '-' ? 0.8 : 1.25);
				this.invalidate(INVALIDATE_LIGHT);
				break;
			default:
				return;
		}
		event.preventDefault();
	};
	private readonly onFocus = () => {
		this.focused = true;
		this.requested = true;
		this.ownsCrosshair = true;
		this.panel.style.clipPath = 'none';
		this.slider.style.pointerEvents = 'auto';
		if (!this.scale.isEmpty) this.updateSelection();
		else {
			this.setValueText('No chart data.');
			setText(this.reading, 'No chart data.');
		}
		this.invalidate(INVALIDATE_CURSOR);
	};
	private readonly onBlur = () => {
		this.focused = false;
		setText(this.status, '');
		this.panel.style.clipPath = 'inset(50%)';
		this.slider.style.pointerEvents = 'none';
		this.clearCrosshair();
		this.ownsCrosshair = false;
		this.invalidate(INVALIDATE_CURSOR);
	};
	private clearCrosshair() {
		if (this.ownsCrosshair) {
			this.crosshair.visible = false;
			this.crosshair.hoverDirty = true;
		}
	}
	public pointerMoved() {
		this.ownsCrosshair = false;
	}
	public destroy() {
		this.slider.removeEventListener('focus', this.onFocus);
		this.slider.removeEventListener('blur', this.onBlur);
		this.slider.removeEventListener('input', this.onInput);
		this.slider.removeEventListener('keydown', this.onKey);
		for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick', 'wheel'])
			this.panel.removeEventListener(type, stopPropagation);
		this.panel.remove();
		this.summary.remove();
		this.status.remove();
	}
}
