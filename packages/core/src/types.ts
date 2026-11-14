/**
 * Compile-time-only tag that keeps values of the same primitive type apart.
 * It has no runtime cost.
 */
export type Nominal<T, Name extends string> = T & { readonly __nominal: Name };

/** Horizontal or vertical position in CSS pixels. */
export type Coordinate = Nominal<number, 'Coordinate'>;
/** Fractional position on the time scale, in bars. */
export type Logical = Nominal<number, 'Logical'>;
/** Signed integer bar index. Stays stable when history is prepended. */
export type BarIndex = Nominal<number, 'BarIndex'>;
