/**
 * How much of the chart a change affects. Changes between two frames are merged by keeping the
 * highest level, and one draw per animation frame handles them all.
 */
export type Invalidation = 0 | 1 | 2 | 3;

export const INVALIDATE_NONE = 0;
/** Overlay only: crosshair. */
export const INVALIDATE_CURSOR = 1;
/** Series layer, axes and overlay. */
export const INVALIDATE_LIGHT = 2;
/** Layout and canvas sizes, then everything. */
export const INVALIDATE_FULL = 3;
