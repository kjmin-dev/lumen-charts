import { type ChartApi, type ChartOptions, createChart } from '@lumen-charts/core';
import { createEffect, type JSX, onCleanup, onMount } from 'solid-js';

export interface LumenChartProps {
	options?: Partial<ChartOptions>;
	class?: string;
	/** Called once with the chart instance after it is created. */
	onReady?: (chart: ChartApi) => void;
}

/**
 * Renders a chart into a div (client-side only).
 * Feed data through the chart API received in `onReady`.
 */
export function LumenChart(props: LumenChartProps): JSX.Element {
	const container = document.createElement('div');
	let chart: ChartApi | null = null;

	createEffect(() => {
		container.className = props.class ?? '';
	});

	onMount(() => {
		const instance = createChart(container, props.options);
		chart = instance;
		props.onReady?.(instance);
	});

	createEffect(() => {
		const options = props.options;
		if (options !== undefined) {
			chart?.applyOptions(options);
		}
	});

	onCleanup(() => {
		chart?.destroy();
		chart = null;
	});

	return container;
}

export type { ChartApi, ChartOptions } from '@lumen-charts/core';
