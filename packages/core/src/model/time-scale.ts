/** Smallest bar spacing the user can zoom to once all data already fits, in CSS pixels. */
const MIN_BAR_SPACING = 0.5;
/** Bars that always stay in view when scrolling past either end of the data. */
const MIN_VISIBLE_BARS = 2;

/**
 * Ordinal time scale: bars are placed by index, not by time, so gaps in time take no space.
 *
 * Bar `i` is centered on logical position `i` and covers `[i - 0.5, i + 0.5)`.
 * The view is defined by `barSpacing` (CSS pixels per bar) and `rightOffset` (bars between the
 * center of the last bar and half a bar short of the right edge; negative when the last bar is
 * scrolled out to the right).
 */
export class TimeScale {
	/** Width of the pane in CSS pixels. */
	public width = 0;
	public barSpacing: number;
	public rightOffset: number;
	/** Extent of the main timeline: `[first, end)`. */
	public first = 0;
	public end = 0;
	/** Increases whenever the mapping between indexes and pixels changes. */
	public version = 0;

	public constructor(barSpacing: number, rightOffset: number) {
		this.barSpacing = barSpacing;
		this.rightOffset = rightOffset;
	}

	public get isEmpty(): boolean {
		return this.end <= this.first;
	}

	/** CSS x of the center of bar `index`. */
	public indexToX(index: number): number {
		return this.width - (this.end - 1 + this.rightOffset - index + 0.5) * this.barSpacing;
	}

	/** Logical position under CSS x. */
	public xToLogical(x: number): number {
		return this.end - 1 + this.rightOffset + 0.5 - (this.width - x) / this.barSpacing;
	}

	/** Logical position at the left edge of the pane. */
	public get from(): number {
		return this.xToLogical(0);
	}

	/** Logical position at the right edge of the pane. */
	public get to(): number {
		return this.end - 1 + this.rightOffset + 0.5;
	}

	public setWidth(width: number): void {
		if (width === this.width) {
			return;
		}
		this.width = width;
		this.version++;
		this._clamp();
	}

	/**
	 * Follows a change of the data extent. While the last bar is in view the chart keeps following
	 * new bars; once the user has scrolled it out of view, the bars on screen stay where they are.
	 */
	public setExtent(first: number, end: number): void {
		if (first === this.first && end === this.end) {
			return;
		}
		const wasEmpty = this.isEmpty;
		const added = end - this.end;
		this.first = first;
		this.end = end;
		if (!wasEmpty && added !== 0 && this.rightOffset < 0) {
			this.rightOffset -= added;
		}
		this.version++;
		this._clamp();
	}

	/** Puts the view back to its starting position; used when the timeline is replaced. */
	public reset(barSpacing: number, rightOffset: number): void {
		this.barSpacing = barSpacing;
		this.rightOffset = rightOffset;
		this.version++;
		this._clamp();
	}

	/** Moves the content by `dx` CSS pixels (positive moves bars to the right, revealing history). */
	public scrollBy(dx: number): void {
		if (dx === 0 || !Number.isFinite(dx)) {
			return;
		}
		this.rightOffset -= dx / this.barSpacing;
		this.version++;
		this._clamp();
	}

	/** Multiplies the bar spacing by `factor`, keeping the logical position under `anchorX` in place. */
	public zoomAt(anchorX: number, factor: number): void {
		if (!Number.isFinite(anchorX) || !(factor > 0) || !Number.isFinite(factor)) {
			return;
		}
		const logical = this.xToLogical(anchorX);
		const spacing = this._clampSpacing(this.barSpacing * factor);
		if (spacing === this.barSpacing) {
			return;
		}
		this.barSpacing = spacing;
		this.rightOffset = logical - (this.end - 1) - 0.5 + (this.width - anchorX) / spacing;
		this.version++;
		this._clamp();
	}

	/** Shows logical positions `[from, to]` across the full width. */
	public setVisibleRange(from: number, to: number): void {
		if (!(to > from) || this.width <= 0 || !Number.isFinite(to - from)) {
			return;
		}
		this.barSpacing = this._clampSpacing(this.width / (to - from));
		this.rightOffset = to - (this.end - 1) - 0.5;
		this.version++;
		this._clamp();
	}

	/** Shows every bar. */
	public fitContent(): void {
		if (this.isEmpty) {
			return;
		}
		this.setVisibleRange(this.first - 0.5, this.end - 0.5);
	}

	/** Scrolls so the last bar sits at the right edge. */
	public scrollToRealTime(): void {
		if (this.rightOffset !== 0) {
			this.rightOffset = 0;
			this.version++;
		}
	}

	private _clampSpacing(spacing: number): number {
		const count = this.end - this.first;
		// Zooming out stops at the point where all data fits, however small that makes a bar.
		const min = count > 0 && this.width > 0 ? Math.min(MIN_BAR_SPACING, this.width / count) : MIN_BAR_SPACING;
		const max = Math.max(min, this.width > 0 ? this.width / MIN_VISIBLE_BARS : 100);
		return spacing < min ? min : spacing > max ? max : spacing;
	}

	private _clamp(): void {
		this.barSpacing = this._clampSpacing(this.barSpacing);
		const count = this.end - this.first;
		if (count <= 0 || this.width <= 0) {
			return;
		}
		const keep = Math.min(MIN_VISIBLE_BARS, count);
		const max = this.width / this.barSpacing - keep;
		const min = keep - count;
		if (this.rightOffset > max) {
			this.rightOffset = max;
		}
		if (this.rightOffset < min) {
			this.rightOffset = min;
		}
	}
}
