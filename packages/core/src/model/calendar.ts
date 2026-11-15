/** UTC calendar arithmetic on millisecond timestamps, without allocating `Date` objects. */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Result of the last `civil` call. */
export let civilYear = 1970;
export let civilMonth = 1;
export let civilDay = 1;

/** Splits a day number (days since 1970-01-01) into year, month (1 to 12) and day (1 to 31). */
export function civil(days: number): void {
	const z = days + 719468;
	const era = Math.floor(z / 146097);
	const doe = z - era * 146097;
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	civilDay = doy - Math.floor((153 * mp + 2) / 5) + 1;
	civilMonth = mp < 10 ? mp + 3 : mp - 9;
	civilYear = yoe + era * 400 + (civilMonth <= 2 ? 1 : 0);
}

/** Day number of a calendar date. Months past 12 roll into the following years. */
export function daysFromCivil(year: number, month: number, day: number): number {
	year += Math.floor((month - 1) / 12);
	month = ((month - 1) % 12) + 1;
	const y = month <= 2 ? year - 1 : year;
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

export function daysInMonth(year: number, month: number): number {
	return daysFromCivil(year, month + 1, 1) - daysFromCivil(year, month, 1);
}
