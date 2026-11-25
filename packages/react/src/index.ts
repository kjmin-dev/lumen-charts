import { type ChartApi, type ChartOptions, type DeepPartial, createChart } from '@lumen-ticks/core';
import { type CSSProperties, createElement, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface LumenChartProps {
	options?: DeepPartial<ChartOptions>;
	className?: string;
	style?: CSSProperties;
}

/**
 * Renders a chart into a div. The ref exposes the chart instance (null until mounted).
 * Feed data through the chart API, not through props.
 */
export const LumenChart = forwardRef<ChartApi | null, LumenChartProps>(function LumenChart(props, ref) {
	const container = useRef<HTMLDivElement>(null);
	// Held in state so that creating the chart renders again and the ref is handed the instance.
	const [chart, setChart] = useState<ChartApi | null>(null);
	const { options, className, style } = props;
	// The latest options, read when the chart is created; changes after that go through applyOptions.
	const latestOptions = useRef(options);
	latestOptions.current = options;
	// The options the current chart was created with, so they are not applied to it a second time.
	const createdWith = useRef<DeepPartial<ChartOptions> | undefined>(undefined);

	useEffect(() => {
		if (container.current === null) {
			return;
		}
		createdWith.current = latestOptions.current;
		const instance = createChart(container.current, createdWith.current);
		setChart(instance);
		return () => {
			setChart(null);
			instance.destroy();
		};
	}, []);

	useEffect(() => {
		if (chart === null) {
			return;
		}
		if (options !== undefined && options !== createdWith.current) {
			chart.applyOptions(options);
		}
		createdWith.current = undefined;
	}, [chart, options]);

	useImperativeHandle<ChartApi | null, ChartApi | null>(ref, () => chart, [chart]);

	return createElement('div', { ref: container, className, style });
});

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
} from '@lumen-ticks/core';
