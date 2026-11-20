import { clipPricePane } from './chrome';
import type { LevelWindow } from '../data/window-cache';
import type { PriceScale } from '../model/price-scale';
import type { TimeIndex } from '../model/time-index';
import {
	type DrawTarget,
	HIT_NONE,
	type PanePrimitive,
	type PaneView,
	type PrimitiveBounds,
	type PrimitiveHost,
	type PrimitiveZOrder,
} from '../primitives';

/**
 * What drawings and primitives need of a price scale: the mapping between prices and pane rows, and
 * how its axis formats prices. Nothing more, so any kind of scale (linear, logarithmic, percentage,
 * indexed, inverted) and any number of them can sit behind it.
 */
export interface PriceMapping {
	readonly top: number;
	readonly height: number;
	/** CSS y from the top of the pane; NaN for a price the scale cannot show. */
	priceToY(price: number): number;
	/** The price at a CSS y; NaN where there is none. */
	yToPrice(y: number): number;
	format(price: number): string;
	/** Changes whenever the mapping changes, together with `base`. */
	readonly version: number;
	/** The base price of a percentage or indexed scale, NaN for none; the mapping changes with it. */
	readonly base: number;
	/** Changes whenever `format` may format differently. */
	readonly formatKey: number;
}

/**
 * Prices of a chart's price scale: mapped with the scale's base (its first series' value at the first
 * visible bar on a percentage or indexed scale), so a drawing sits at its price as the crosshair
 * reads it on that scale. Nothing maps before the scale has a range, nor what it cannot show.
 */
export class ScaleMapping implements PriceMapping {
	private readonly _scale: PriceScale;

	public constructor(scale: PriceScale) {
		this._scale = scale;
	}

	public get top() {
		return this._scale.top;
	}
	public get height() {
		return this._scale.height;
	}

	public priceToY(price: number): number {
		const scale = this._scale;
		if (!scale.hasRange) {
			return NaN;
		}
		const y = scale.priceToY(price);
		return Number.isFinite(y) ? y : NaN;
	}

	public yToPrice(y: number): number {
		const scale = this._scale;
		if (!scale.hasRange) {
			return NaN;
		}
		const price = scale.yToPrice(y);
		return Number.isFinite(price) ? price : NaN;
	}

	public format(price: number): string {
		return this._scale.formatPrice(price);
	}

	public get version(): number {
		return this._scale.version;
	}

	public get base(): number {
		return this._scale.base;
	}

	public get formatKey(): number {
		return this._scale.formatVersion;
	}
}

/** The view primitives on one price scale are drawn with (see `PaneView`). */
export class PaneViewState implements PaneView {
	public width = 0;
	public height = 0;
	public pixelRatio = 1;
	public from = 0;
	public to = 0;
	public barSpacing = 1;
	public firstBar = 0;
	public lastBar = -1;
	public priceFormatVersion = 0;
	/** Changes whenever anything a primitive's geometry depends on changes. */
	public version = 0;
	/** Id of the price scale the view maps prices with. */
	public readonly scaleId: string;
	/** Device-pixel position of bar 0 and device pixels per bar, as the series are drawn. */
	private _origin = 0;
	private _spacing = 1;
	private _priceVersion = -1;
	private _priceBase = NaN;
	/** Timeline version as of the last `sync`. */
	private _timeline = 0;
	private readonly _times: TimeIndex;
	private readonly _price: PriceMapping;
	private readonly _coarse: () => LevelWindow | null;

	public constructor(scaleId: string, times: TimeIndex, price: PriceMapping, coarse: () => LevelWindow | null) {
		this.scaleId = scaleId;
		this._times = times;
		this._price = price;
		this._coarse = coarse;
	}

	public containsY(y: number): boolean {
		return y >= this._price.top && y < this._price.top + this._price.height;
	}

	public clip(target: DrawTarget): boolean {
		return clipPricePane(
			target.context,
			Math.round(target.width * target.pixelRatio),
			target.pixelRatio,
			this._price.top,
			this._price.height,
			target.height,
		);
	}

	public get priceMapping(): PriceMapping {
		return this._price;
	}

	/** Always that of the time index, also between two frames: `timeToLogical` answers from it. */
	public get timelineVersion(): number {
		return this._times.version;
	}

	/** Takes over the frame's mapping; `version` changes if anything differs from the last frame. */
	public sync(
		origin: number,
		spacing: number,
		pixelRatio: number,
		width: number,
		height: number,
		firstBar: number,
		lastBar: number,
	): void {
		const price = this._price;
		const timeline = this._times.version;
		const base = price.base;
		if (
			origin === this._origin &&
			spacing === this._spacing &&
			pixelRatio === this.pixelRatio &&
			width === this.width &&
			height === this.height &&
			firstBar === this.firstBar &&
			lastBar === this.lastBar &&
			price.version === this._priceVersion &&
			(base === this._priceBase || (base !== base && this._priceBase !== this._priceBase)) &&
			timeline === this._timeline
		) {
			return;
		}
		this._priceBase = base;
		this._origin = origin;
		this._spacing = spacing;
		this.pixelRatio = pixelRatio;
		this.width = width;
		this.height = height;
		this.barSpacing = spacing / pixelRatio;
		this.firstBar = firstBar;
		this.lastBar = lastBar;
		this.from = this.xToLogical(0);
		this.to = this.xToLogical(width);
		this._priceVersion = price.version;
		this._timeline = timeline;
		this.priceFormatVersion = price.formatKey;
		this.version++;
	}

	public logicalToX(logical: number): number {
		return (this._origin + logical * this._spacing) / this.pixelRatio;
	}

	public xToLogical(x: number): number {
		return (x * this.pixelRatio - this._origin) / this._spacing;
	}

	public timeToLogical(time: number): number {
		return this._times.lookup(time);
	}

	public logicalToTime(logical: number): number {
		return this._times.timeAt(logical, this._coarse());
	}

	public timeToX(time: number): number {
		return this.logicalToX(this._times.lookup(time));
	}

	public xToTime(x: number): number {
		return this.logicalToTime(this.xToLogical(x));
	}

	public priceToY(price: number): number {
		return this._price.priceToY(price);
	}

	public yToPrice(y: number): number {
		return this._price.yToPrice(y);
	}

	public formatPrice(price: number): string {
		return this._price.format(price);
	}
}

/** A primitive attached to the pane, with what the chart keeps for it. */
export class PrimitiveEntry implements PrimitiveHost {
	public readonly primitive: PanePrimitive;
	public readonly view: PaneViewState;
	public readonly zOrder: PrimitiveZOrder;
	public zIndex: number;
	/** Attach order, which breaks ties of `zIndex`. */
	public seq: number;
	/** Slot of its bounds in the layer's bounds array. */
	public slot = -1;
	/** Needs `update` regardless of the view. */
	public dirty = true;
	/** View version of the last `update`. */
	public seen = -1;
	/** Left out of its layer, for example while it is being edited on the overlay. */
	public hidden = false;
	/** Whatever the owner keeps with it (a built-in drawing knows its own). */
	public owner: unknown = null;
	/** Whether the primitive takes part in autoscale (it has `autoscale`), as of the last change. */
	public autoscales = false;
	/** Its place in `PrimitiveLayers.autoscaling` and `ranges` while it does. */
	public rangeSlot = -1;
	private readonly _layers: PrimitiveLayers;

	public constructor(layers: PrimitiveLayers, primitive: PanePrimitive, view: PaneViewState, seq: number) {
		this._layers = layers;
		this.primitive = primitive;
		this.view = view;
		this.zOrder = primitive.zOrder ?? 'normal';
		this.zIndex = primitive.zIndex ?? 0;
		this.seq = seq;
	}

	public requestUpdate(): void {
		this._layers.changed(this);
	}
}

const EMPTY = Infinity;

/** The primitives of one z-order, kept in drawing order with their bounds. */
export class PrimitiveLayer {
	public readonly zOrder: PrimitiveZOrder;
	/** In drawing order: by `zIndex`, then attach order. */
	public readonly entries: PrimitiveEntry[] = [];
	/** Left, top, right and bottom of each entry, by slot. */
	public bounds = new Float64Array(64);
	/** Needs a redraw: something in it changed since it was last drawn. */
	public changed = true;
	private _orderDirty = false;
	private readonly _free: number[] = [];
	private _slots = 0;

	public constructor(zOrder: PrimitiveZOrder) {
		this.zOrder = zOrder;
	}

	public add(entry: PrimitiveEntry): void {
		let slot = this._free.pop();
		if (slot === undefined) {
			slot = this._slots++;
			if (slot * 4 === this.bounds.length) {
				const grown = new Float64Array(this.bounds.length * 2);
				grown.set(this.bounds);
				this.bounds = grown;
			}
		}
		entry.slot = slot;
		this.bounds[slot * 4] = EMPTY;
		this.bounds[slot * 4 + 2] = -EMPTY;
		this.entries.push(entry);
		this._orderDirty = true;
		this.changed = true;
	}

	public remove(entry: PrimitiveEntry): boolean {
		// From the end: the entries added last are the ones removed most (a clear goes from the top).
		const index = this.entries.lastIndexOf(entry);
		if (index < 0) {
			return false;
		}
		this.entries.splice(index, 1);
		this._free.push(entry.slot);
		this.changed = true;
		return true;
	}

	/** The order changed (a `zIndex`): sorted again before the next use. */
	public reorder(): void {
		this._orderDirty = true;
		this.changed = true;
	}

	public sort(): void {
		if (this._orderDirty) {
			this._orderDirty = false;
			this.entries.sort(byZ);
		}
	}

	/**
	 * Updates the entries whose view changed or that asked for it, keeping their bounds. Returns true
	 * when any was updated, so the layer needs a redraw.
	 */
	public update(scratch: PrimitiveBounds): boolean {
		this.sort();
		const entries = this.entries;
		const bounds = this.bounds;
		let updated = false;
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			const view = entry.view;
			if (!entry.dirty && entry.seen === view.version) {
				continue;
			}
			entry.dirty = false;
			entry.seen = view.version;
			// One drawn elsewhere (edited on the overlay) changes nothing in this layer.
			if (!entry.hidden) {
				updated = true;
			}
			scratch.left = 0;
			scratch.top = 0;
			scratch.right = view.width;
			scratch.bottom = view.height;
			entry.primitive.update?.(view, scratch);
			const at = entry.slot * 4;
			const empty = !(scratch.left <= scratch.right && scratch.top <= scratch.bottom);
			bounds[at] = empty ? EMPTY : scratch.left;
			bounds[at + 1] = empty ? EMPTY : scratch.top;
			bounds[at + 2] = empty ? -EMPTY : scratch.right;
			bounds[at + 3] = empty ? -EMPTY : scratch.bottom;
		}
		if (updated) {
			this.changed = true;
		}
		return updated;
	}

	/** Draws the entries that are in the pane and not hidden, in order. */
	public draw(target: DrawTarget): void {
		const entries = this.entries;
		const bounds = this.bounds;
		const width = target.width;
		const height = target.height;
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			const at = entry.slot * 4;
			if (
				entry.hidden ||
				bounds[at]! > width ||
				bounds[at + 2]! < 0 ||
				bounds[at + 1]! > height ||
				bounds[at + 3]! < 0
			) {
				continue;
			}
			const clipped = entry.view.clip(target);
			entry.primitive.draw(target, entry.view);
			if (clipped) target.context.restore();
		}
		this.changed = false;
	}

	/**
	 * The topmost entry hit at `(x, y)` within `tolerance`, or null; `hit` receives its code. Bounds
	 * filter first, so only entries near the point run their own test.
	 */
	public hitTest(x: number, y: number, tolerance: number, result: HitResult): boolean {
		this.sort();
		const entries = this.entries;
		const bounds = this.bounds;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			const at = entry.slot * 4;
			if (
				x < bounds[at]! - tolerance ||
				x > bounds[at + 2]! + tolerance ||
				y < bounds[at + 1]! - tolerance ||
				y > bounds[at + 3]! + tolerance
			) {
				continue;
			}
			const primitive = entry.primitive;
			if (primitive.hitTest === undefined || entry.hidden || !entry.view.containsY(y)) {
				continue;
			}
			const hit = primitive.hitTest(x, y, tolerance);
			if (hit !== HIT_NONE && hit === hit) {
				result.entry = entry;
				result.hit = hit;
				return true;
			}
		}
		return false;
	}
}

/** Outcome of a hit test: the entry hit and its code (see `PanePrimitive.hitTest`). */
export interface HitResult {
	entry: PrimitiveEntry | null;
	hit: number;
}

function byZ(a: PrimitiveEntry, b: PrimitiveEntry): number {
	return a.zIndex - b.zIndex || a.seq - b.seq;
}

/** What the layers need from the chart. */
export interface PrimitiveLayersHost {
	/** A primitive of this z-order changed and its layer must be redrawn. */
	primitiveChanged(zOrder: PrimitiveZOrder): void;
	/** What a primitive gives autoscale may have changed: price ranges must be computed again. */
	rangeChanged(): void;
}

/** Every primitive of the pane, in its three layers. */
export class PrimitiveLayers {
	public readonly bottom = new PrimitiveLayer('bottom');
	public readonly normal = new PrimitiveLayer('normal');
	public readonly top = new PrimitiveLayer('top');
	/** The entries that take part in autoscale, of every layer and in no order: the only ones a model update looks at. */
	public readonly autoscaling: PrimitiveEntry[] = [];
	/**
	 * Four numbers per entry of `autoscaling`, like the bounds of a layer but in data: the logical
	 * positions its answer holds between, and the lowest and highest price it gave (NaN for none). A
	 * first number that is NaN says the entry has to be asked: it gave no span, or it changed since.
	 */
	public ranges = new Float64Array(64);
	private readonly _host: PrimitiveLayersHost;
	private readonly _byPrimitive = new Map<PanePrimitive, PrimitiveEntry>();
	private _seq = 0;

	public constructor(host: PrimitiveLayersHost) {
		this._host = host;
	}

	public get size(): number {
		return this._byPrimitive.size;
	}

	public layer(zOrder: PrimitiveZOrder): PrimitiveLayer {
		return zOrder === 'bottom' ? this.bottom : zOrder === 'top' ? this.top : this.normal;
	}

	public entryOf(primitive: PanePrimitive): PrimitiveEntry | undefined {
		return this._byPrimitive.get(primitive);
	}

	/** Attaches a primitive drawn with `view`. Attaching it again does nothing. */
	public attach(primitive: PanePrimitive, view: PaneViewState, owner: unknown = null): PrimitiveEntry {
		const existing = this._byPrimitive.get(primitive);
		if (existing !== undefined) {
			return existing;
		}
		const entry = new PrimitiveEntry(this, primitive, view, this._seq++);
		entry.owner = owner;
		this._byPrimitive.set(primitive, entry);
		this.layer(entry.zOrder).add(entry);
		primitive.attached?.(entry);
		this._host.primitiveChanged(entry.zOrder);
		this._setAutoscales(entry, primitive.autoscale !== undefined);
		return entry;
	}

	public detach(primitive: PanePrimitive): boolean {
		const entry = this._byPrimitive.get(primitive);
		if (entry === undefined) {
			return false;
		}
		this._byPrimitive.delete(primitive);
		this.layer(entry.zOrder).remove(entry);
		this._host.primitiveChanged(entry.zOrder);
		this._setAutoscales(entry, false);
		primitive.detached?.();
		return true;
	}

	/** Detaches every primitive drawn with `view`, for example those of a removed series. */
	public detachView(view: PaneViewState): void {
		for (const [primitive, entry] of this._byPrimitive) {
			if (entry.view === view) {
				this.detach(primitive);
			}
		}
	}

	public detachAll(): void {
		for (const primitive of this._byPrimitive.keys()) {
			this.detach(primitive);
		}
	}

	/**
	 * An entry asked for an update: its `zIndex` is read again and its layer redrawn, unless it is
	 * drawn elsewhere meanwhile (hidden), when only the overlay is. Whether it takes part in autoscale
	 * is read again too, and price ranges are computed again if it does; not while it is hidden, when
	 * what it gave before stands (a drawing being dragged does not move the scale under the pointer).
	 */
	public changed(entry: PrimitiveEntry): void {
		entry.dirty = true;
		if (!this._setAutoscales(entry, entry.primitive.autoscale !== undefined) && entry.autoscales) {
			// Asked again; what it gave last stands meanwhile.
			this._forget(entry.rangeSlot);
			if (!entry.hidden) {
				this._host.rangeChanged();
			}
		}
		const zIndex = entry.primitive.zIndex ?? 0;
		const layer = this.layer(entry.zOrder);
		if (zIndex !== entry.zIndex) {
			entry.zIndex = zIndex;
			layer.reorder();
		}
		if (entry.hidden) {
			this._host.primitiveChanged('top');
			return;
		}
		layer.changed = true;
		this._host.primitiveChanged(entry.zOrder);
	}

	/** Leaves an entry out of its layer (it is drawn elsewhere meanwhile), or puts it back. */
	public setHidden(entry: PrimitiveEntry, hidden: boolean): void {
		if (entry.hidden === hidden) {
			return;
		}
		entry.hidden = hidden;
		this.layer(entry.zOrder).changed = true;
		this._host.primitiveChanged(entry.zOrder);
		if (!hidden && entry.autoscales) {
			this._forget(entry.rangeSlot);
			this._host.rangeChanged();
		}
	}

	/** Has every entry that takes part in autoscale asked again: the timeline or the scales changed. */
	public forgetRanges(): void {
		for (let i = this.autoscaling.length - 1; i >= 0; i--) {
			this._forget(i);
		}
	}

	/** Drops the span of the entry in `slot`, so it is asked again; the prices it gave stay. */
	private _forget(slot: number): void {
		this.ranges[slot * 4] = NaN;
		this.ranges[slot * 4 + 1] = NaN;
	}

	/** Gives an entry a new place in the attach order, after every other entry's. */
	public resequence(entry: PrimitiveEntry): void {
		entry.seq = this._seq++;
		this.layer(entry.zOrder).reorder();
		this._host.primitiveChanged(entry.zOrder);
	}

	/** Lists or unlists an entry for autoscale. Returns true when that changed, and ranges with it. */
	private _setAutoscales(entry: PrimitiveEntry, autoscales: boolean): boolean {
		if (autoscales === entry.autoscales) {
			return false;
		}
		entry.autoscales = autoscales;
		const list = this.autoscaling;
		let ranges = this.ranges;
		if (autoscales) {
			const slot = list.length;
			if (slot * 4 === ranges.length) {
				ranges = new Float64Array(ranges.length * 2);
				ranges.set(this.ranges);
				this.ranges = ranges;
			}
			entry.rangeSlot = slot;
			list.push(entry);
			ranges.fill(NaN, slot * 4, slot * 4 + 4);
		} else {
			// The last entry takes its place: the list has no order to keep.
			const slot = entry.rangeSlot;
			const last = list.pop()!;
			if (last !== entry) {
				list[slot] = last;
				last.rangeSlot = slot;
				ranges.copyWithin(slot * 4, list.length * 4, list.length * 4 + 4);
			}
			entry.rangeSlot = -1;
		}
		this._host.rangeChanged();
		return true;
	}
}
