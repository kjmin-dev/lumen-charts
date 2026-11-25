import { type ChartApi, type ChartOptions, type DeepPartial, createChart } from '@lumen-ticks/core';
import { defineComponent, h, onBeforeUnmount, onMounted, type PropType, shallowRef, watch } from 'vue';

/**
 * Renders a chart into a div. The chart instance is exposed as `chart` on the component ref.
 * Feed data through the chart API, not through props.
 */
export const LumenChart = defineComponent({
	name: 'LumenChart',
	props: {
		options: { type: Object as PropType<DeepPartial<ChartOptions>>, default: undefined },
	},
	setup(props, { expose }) {
		const container = shallowRef<HTMLDivElement | null>(null);
		const chart = shallowRef<ChartApi | null>(null);

		onMounted(() => {
			if (container.value !== null) {
				chart.value = createChart(container.value, props.options);
			}
		});

		watch(
			() => props.options,
			options => {
				if (options !== undefined) {
					chart.value?.applyOptions(options);
				}
			},
			{ deep: true },
		);

		onBeforeUnmount(() => {
			chart.value?.destroy();
			chart.value = null;
		});

		expose({ chart });
		return () => h('div', { ref: container });
	},
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
