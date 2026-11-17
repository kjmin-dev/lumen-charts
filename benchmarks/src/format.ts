// Formatting of the one-line summaries of a case (`headline.ts` and the scenarios' `headline`).

export function ms(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) {
		return '–';
	}
	return value >= 100
		? `${value.toFixed(0)} ms`
		: value >= 1
			? `${value.toFixed(2)} ms`
			: `${(value * 1000).toFixed(1)} µs`;
}

export function mb(value: number | undefined): string {
	return value === undefined || !Number.isFinite(value) ? '–' : `${(value / 2 ** 20).toFixed(1)} MiB`;
}
