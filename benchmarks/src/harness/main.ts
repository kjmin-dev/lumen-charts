/// <reference types="vite/client" />
import type { ChartSize } from '../adapter.ts';
import type { BenchApi } from './api.ts';
import { collectEnvironment } from './environment.ts';
import { installFrameProbe } from './frames.ts';
import { setupManualPage } from './manual.ts';
import { describeProbes, probes } from './probes.ts';
import { runJob } from './scenarios.ts';

// Before any chart exists, so every animation frame a library requests is timed.
installFrameProbe();

const DEFAULT_CHART: ChartSize = { width: 1200, height: 600 };

function chartSizeFromQuery(params: URLSearchParams): ChartSize {
	const read = (name: string, fallback: number): number => {
		const value = Number(params.get(name));
		return Number.isInteger(value) && value > 0 ? value : fallback;
	};
	return { width: read('width', DEFAULT_CHART.width), height: read('height', DEFAULT_CHART.height) };
}

const params = new URLSearchParams(window.location.search);
const chart = chartSizeFromQuery(params);
const container = document.getElementById('chart');
if (container === null) {
	throw new Error('Missing #chart element');
}

function sizeContainer(size: ChartSize): void {
	if (container === null) {
		return;
	}
	container.style.width = `${size.width}px`;
	container.style.height = `${size.height}px`;
}
sizeContainer(chart);

const bench: BenchApi = {
	environment: () => collectEnvironment(chart, describeProbes(), import.meta.env.MODE),
	run: job => {
		sizeContainer(job.chart);
		return runJob(job, container, probes);
	},
};
window.bench = bench;

if (!params.has('auto')) {
	setupManualPage(bench, chart);
}
