import { type ChartApi, type ChartOptions, createChart } from '@lumen-charts/core';
import { type CSSProperties, createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface LumenChartProps {
	options?: Partial<ChartOptions>;
	className?: string;
	style?: CSSProperties;
}

/**
 * Renders a chart into a div. The ref exposes the chart instance (null until mounted).
 * Feed data through the chart API, not through props.
 */
export const LumenChart = forwardRef<ChartApi | null, LumenChartProps>(function LumenChart(props, ref) {
	const container = useRef<HTMLDivElement>(null);
	const chart = useRef<ChartApi | null>(null);
	const { options, className, style } = props;

	// biome-ignore lint/correctness/useExhaustiveDependencies: the chart is created once; later option changes go through applyOptions below
	useEffect(() => {
		if (container.current === null) {
			return;
		}
		const instance = createChart(container.current, options);
		chart.current = instance;
		return () => {
			chart.current = null;
			instance.destroy();
		};
	}, []);

	useEffect(() => {
		if (options !== undefined) {
			chart.current?.applyOptions(options);
		}
	}, [options]);

	useImperativeHandle<ChartApi | null, ChartApi | null>(ref, () => chart.current, []);

	return createElement('div', { ref: container, className, style });
});

export type { ChartApi, ChartOptions } from '@lumen-charts/core';
