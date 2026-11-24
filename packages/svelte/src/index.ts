import { type ChartApi, type ChartOptions, type DeepPartial, createChart } from '@lumen-charts/core';
import type { ActionReturn } from 'svelte/action';

export interface LumenChartParams {
	options?: DeepPartial<ChartOptions>;
	/** Called once with the chart instance after it is created. */
	onReady?: (chart: ChartApi) => void;
}

/**
 * Svelte action: `<div use:lumenChart={{ options, onReady }} />`.
 * Feed data through the chart API received in `onReady`.
 */
export function lumenChart(node: HTMLElement, params: LumenChartParams = {}): ActionReturn<LumenChartParams> {
	const chart = createChart(node, params.options);
	params.onReady?.(chart);
	return {
		update(next: LumenChartParams = {}) {
			if (next.options !== undefined) {
				chart.applyOptions(next.options);
			}
		},
		destroy() {
			chart.destroy();
		},
	};
}

export {
	type ChartApi,
	type ChartOptions,
	type DeepPartial,
	type WorkerConfig,
	type WorkerConstructor,
	type WorkerFactory,
	type WorkerOption,
	type WorkerPool,
	type WorkerPoolOptions,
	type WorkerSource,
	configureWorker,
	createWorkerPool,
	getMaxWorkers,
	getWorkerConfig,
	setMaxWorkers,
} from '@lumen-charts/core';
