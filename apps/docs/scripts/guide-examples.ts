// Framework wrapper equivalents (React, Vue 3, Svelte 5, Solid) for code blocks in docs/guide/*.md.
// Applied by scripts/generate.ts so every guide offers synced Vanilla / React / Vue 3 / Svelte 5 / Solid tabs
// without duplicating wrapper boilerplate inside docs/guide/*.md.

export interface GuideCodeTabs {
	/** 0-based index of the fenced code block in `docs/guide/<slug>.md` to wrap in synced framework tabs. */
	blockIndex: number;
	/** Substring that must appear in the target code block, catching drift if the source guide changes. */
	match: string;
	react: string;
	vue: string;
	svelte: string;
	solid: string;
}

export const GUIDE_EXAMPLES: Readonly<Record<string, readonly GuideCodeTabs[]>> = {
	themes: [
		{
			blockIndex: 0,
			match: "theme: 'auto'",
			react: `import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/react';
import { useEffect, useMemo, useState } from 'react';

export function ThemedChart({ textColor = '#8a93a6' }: { textColor?: string }) {
	const [chart, setChart] = useState<ChartApi | null>(null);

	// Nested options merge when updated; memoize so unrelated renders skip applyOptions.
	const options = useMemo<DeepPartial<ChartOptions>>(
		() => ({
			theme: 'auto', // 'light' (default), 'dark', or follow the system setting
			grid: { vertLines: { visible: false }, horzLines: { style: 'dashed' } },
			crosshair: { mode: 'magnet' }, // or 'nearest', 'normal', 'hidden'
			priceScale: { position: 'left', scaleMargins: { top: 0.1, bottom: 0.2 } },
			watermark: { visible: true, text: 'BTCUSD · 1m' },
			layout: { textColor },
		}),
		[textColor],
	);

	useEffect(() => {
		if (chart === null) return;
		const candles = chart.addSeries('candlestick', {
			upColor: 'rgba(0, 0, 0, 0)', // hollow up candles
			borderVisible: true,
			priceLineStyle: 'dotted',
		});
		const average = chart.addSeries('line', { color: '#f5b83d', lineType: 'step', lineStyle: 'dashed' });
		return () => {
			chart.removeSeries(average);
			chart.removeSeries(candles);
		};
	}, [chart]);

	return <LumenChart ref={setChart} options={options} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/vue';
import { computed, onMounted, useTemplateRef } from 'vue';

const props = withDefaults(defineProps<{ textColor?: string }>(), { textColor: '#8a93a6' });
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');

// Reactive options are forwarded to chart.applyOptions() automatically.
const options = computed<DeepPartial<ChartOptions>>(() => ({
	theme: 'auto',
	grid: { vertLines: { visible: false }, horzLines: { style: 'dashed' } },
	crosshair: { mode: 'magnet' },
	priceScale: { position: 'left', scaleMargins: { top: 0.1, bottom: 0.2 } },
	watermark: { visible: true, text: 'BTCUSD · 1m' },
	layout: { textColor: props.textColor },
}));

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	chart.addSeries('candlestick', {
		upColor: 'rgba(0, 0, 0, 0)', // hollow up candles
		borderVisible: true,
		priceLineStyle: 'dotted',
	});
	chart.addSeries('line', { color: '#f5b83d', lineType: 'step', lineStyle: 'dashed' });
});
</script>

<template>
	<LumenChart ref="chartEl" :options="options" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import { lumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/svelte';

	let { textColor = '#8a93a6' }: { textColor?: string } = $props();

	const options = $derived<DeepPartial<ChartOptions>>({
		theme: 'auto',
		grid: { vertLines: { visible: false }, horzLines: { style: 'dashed' } },
		crosshair: { mode: 'magnet' },
		priceScale: { position: 'left', scaleMargins: { top: 0.1, bottom: 0.2 } },
		watermark: { visible: true, text: 'BTCUSD · 1m' },
		layout: { textColor },
	});

	function onReady(chart: ChartApi) {
		chart.addSeries('candlestick', {
			upColor: 'rgba(0, 0, 0, 0)', // hollow up candles
			borderVisible: true,
			priceLineStyle: 'dotted',
		});
		chart.addSeries('line', { color: '#f5b83d', lineType: 'step', lineStyle: 'dashed' });
	}
</script>

<div style="height: 420px" use:lumenChart={{ options, onReady }}></div>`,
			solid: `import { LumenChart, type ChartApi } from '@lumen-charts/solid';

export function ThemedChart(props: { textColor?: string }) {
	const handleReady = (chart: ChartApi) => {
		chart.addSeries('candlestick', {
			upColor: 'rgba(0, 0, 0, 0)', // hollow up candles
			borderVisible: true,
			priceLineStyle: 'dotted',
		});
		chart.addSeries('line', { color: '#f5b83d', lineType: 'step', lineStyle: 'dashed' });
	};

	return (
		<LumenChart
			class="chart-box"
			options={{
				theme: 'auto',
				grid: { vertLines: { visible: false }, horzLines: { style: 'dashed' } },
				crosshair: { mode: 'magnet' },
				priceScale: { position: 'left', scaleMargins: { top: 0.1, bottom: 0.2 } },
				watermark: { visible: true, text: 'BTCUSD · 1m' },
				layout: { textColor: props.textColor ?? '#8a93a6' },
			}}
			onReady={handleReady}
		/>
	);
}`,
		},
		{
			blockIndex: 1,
			match: "redraw: 'full'",
			react: `import { LumenChart } from '@lumen-charts/react';
import { useMemo } from 'react';

export function SoftwareSafeChart({ redraw = 'full' }: { redraw?: 'auto' | 'full' }) {
	const options = useMemo(() => ({ redraw }), [redraw]);
	return <LumenChart options={options} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import { LumenChart } from '@lumen-charts/vue';
import { computed } from 'vue';

const props = withDefaults(defineProps<{ redraw?: 'auto' | 'full' }>(), { redraw: 'full' });
const options = computed(() => ({ redraw: props.redraw }));
</script>

<template>
	<LumenChart :options="options" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import { lumenChart } from '@lumen-charts/svelte';

	let { redraw = 'full' }: { redraw?: 'auto' | 'full' } = $props();
</script>

<div style="height: 420px" use:lumenChart={{ options: { redraw } }}></div>`,
			solid: `import { LumenChart } from '@lumen-charts/solid';

export function SoftwareSafeChart(props: { redraw?: 'auto' | 'full' }) {
	return <LumenChart class="chart-box" options={{ redraw: props.redraw ?? 'full' }} />;
}`,
		},
	],

	indicators: [
		{
			blockIndex: 0,
			match: "candles.addIndicator('bollinger'",
			react: `import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

export function IndicatorsChart({ data }: { data: OhlcColumns }) {
	const [chart, setChart] = useState<ChartApi | null>(null);

	useEffect(() => {
		if (chart === null) return;
		const candles = chart.addSeries('candlestick');
		candles.setData(data);

		const fast = candles.addIndicator('ema', { params: { period: 12 } });
		const bands = candles.addIndicator('bollinger', {
			params: { period: 20, multiplier: 2 },
			outputs: { middle: { color: '#ffa726', lineStyle: 'dashed' } },
		});
		const strength = candles.addIndicator('rsi');
		// Chains: an indicator of another indicator's output.
		const smoothed = strength.output().addIndicator('sma', { params: { period: 9 } });

		fast.applyOptions({ params: { period: 21 } }); // recomputed in the background
		bands.output('upper').applyOptions({ color: '#42a5f5' }); // style only
		strength.output().lastValue(); // for a legend, NaN until computed
		smoothed.remove();

		return () => chart.removeSeries(candles); // removes indicators reading candles too
	}, [chart, data]);

	return <LumenChart ref={setChart} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onMounted, useTemplateRef } from 'vue';

const props = defineProps<{ data: OhlcColumns }>();
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const candles = chart.addSeries('candlestick');
	candles.setData(props.data);

	const fast = candles.addIndicator('ema', { params: { period: 12 } });
	const bands = candles.addIndicator('bollinger', {
		params: { period: 20, multiplier: 2 },
		outputs: { middle: { color: '#ffa726', lineStyle: 'dashed' } },
	});
	const strength = candles.addIndicator('rsi');
	const smoothed = strength.output().addIndicator('sma', { params: { period: 9 } });

	fast.applyOptions({ params: { period: 21 } });
	bands.output('upper').applyOptions({ color: '#42a5f5' });
	strength.output().lastValue();
	smoothed.remove();
});
</script>

<template>
	<LumenChart ref="chartEl" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import type { OhlcColumns } from '@lumen-charts/core';
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';

	let { data }: { data: OhlcColumns } = $props();

	function onReady(chart: ChartApi) {
		const candles = chart.addSeries('candlestick');
		candles.setData(data);

		const fast = candles.addIndicator('ema', { params: { period: 12 } });
		const bands = candles.addIndicator('bollinger', {
			params: { period: 20, multiplier: 2 },
			outputs: { middle: { color: '#ffa726', lineStyle: 'dashed' } },
		});
		const strength = candles.addIndicator('rsi');
		const smoothed = strength.output().addIndicator('sma', { params: { period: 9 } });

		fast.applyOptions({ params: { period: 21 } });
		bands.output('upper').applyOptions({ color: '#42a5f5' });
		strength.output().lastValue();
		smoothed.remove();
	}
</script>

<div style="height: 420px" use:lumenChart={{ onReady }}></div>`,
			solid: `import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/solid';

export function IndicatorsChart(props: { data: OhlcColumns }) {
	const handleReady = (chart: ChartApi) => {
		const candles = chart.addSeries('candlestick');
		candles.setData(props.data);

		const fast = candles.addIndicator('ema', { params: { period: 12 } });
		const bands = candles.addIndicator('bollinger', {
			params: { period: 20, multiplier: 2 },
			outputs: { middle: { color: '#ffa726', lineStyle: 'dashed' } },
		});
		const strength = candles.addIndicator('rsi');
		const smoothed = strength.output().addIndicator('sma', { params: { period: 9 } });

		fast.applyOptions({ params: { period: 21 } });
		bands.output('upper').applyOptions({ color: '#42a5f5' });
		strength.output().lastValue();
		smoothed.remove();
	};

	return <LumenChart class="chart-box" onReady={handleReady} />;
}`,
		},
		{
			blockIndex: 1,
			match: 'paneWeight: 0.5',
			react: `import type { LineColumns, OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/react';
import { useEffect, useMemo, useState } from 'react';

export function MultiPaneChart({
	bars,
	volumeData,
	oscillatorWeight = 0.5,
}: {
	bars: OhlcColumns;
	volumeData: LineColumns;
	oscillatorWeight?: number;
}) {
	const [chart, setChart] = useState<ChartApi | null>(null);
	const options = useMemo<DeepPartial<ChartOptions>>(
		() => ({
			priceScales: {
				oscillator: { paneWeight: oscillatorWeight, visible: true },
				volume: { paneWeight: 0.5, visible: true },
			},
			crosshair: { mode: 'nearest' },
		}),
		[oscillatorWeight],
	);

	useEffect(() => {
		if (chart === null) return;
		const candles = chart.addSeries('candlestick');
		candles.setData(bars);
		candles.addIndicator('rsi', { priceScaleId: 'oscillator' });
		const volume = chart.addSeries('histogram', { priceScaleId: 'volume' });
		volume.setData(volumeData);
		return () => {
			chart.removeSeries(volume);
			chart.removeSeries(candles);
		};
	}, [chart, bars, volumeData]);

	return <LumenChart ref={setChart} options={options} style={{ height: 480 }} />;
}`,
			vue: `<script setup lang="ts">
import type { LineColumns, OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/vue';
import { computed, onMounted, useTemplateRef } from 'vue';

const props = withDefaults(
	defineProps<{ bars: OhlcColumns; volumeData: LineColumns; oscillatorWeight?: number }>(),
	{ oscillatorWeight: 0.5 },
);
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const options = computed<DeepPartial<ChartOptions>>(() => ({
	priceScales: {
		oscillator: { paneWeight: props.oscillatorWeight, visible: true },
		volume: { paneWeight: 0.5, visible: true },
	},
	crosshair: { mode: 'nearest' },
}));

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const candles = chart.addSeries('candlestick');
	candles.setData(props.bars);
	candles.addIndicator('rsi', { priceScaleId: 'oscillator' });
	const volume = chart.addSeries('histogram', { priceScaleId: 'volume' });
	volume.setData(props.volumeData);
});
</script>

<template>
	<LumenChart ref="chartEl" :options="options" style="height: 480px" />
</template>`,
			svelte: `<script lang="ts">
	import type { LineColumns, OhlcColumns } from '@lumen-charts/core';
	import { lumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/svelte';

	let {
		bars,
		volumeData,
		oscillatorWeight = 0.5,
	}: { bars: OhlcColumns; volumeData: LineColumns; oscillatorWeight?: number } = $props();

	const options = $derived<DeepPartial<ChartOptions>>({
		priceScales: {
			oscillator: { paneWeight: oscillatorWeight, visible: true },
			volume: { paneWeight: 0.5, visible: true },
		},
		crosshair: { mode: 'nearest' },
	});

	function onReady(chart: ChartApi) {
		const candles = chart.addSeries('candlestick');
		candles.setData(bars);
		candles.addIndicator('rsi', { priceScaleId: 'oscillator' });
		const volume = chart.addSeries('histogram', { priceScaleId: 'volume' });
		volume.setData(volumeData);
	}
</script>

<div style="height: 480px" use:lumenChart={{ options, onReady }}></div>`,
			solid: `import type { LineColumns, OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/solid';

export function MultiPaneChart(props: {
	bars: OhlcColumns;
	volumeData: LineColumns;
	oscillatorWeight?: number;
}) {
	const handleReady = (chart: ChartApi) => {
		const candles = chart.addSeries('candlestick');
		candles.setData(props.bars);
		candles.addIndicator('rsi', { priceScaleId: 'oscillator' });
		const volume = chart.addSeries('histogram', { priceScaleId: 'volume' });
		volume.setData(props.volumeData);
	};

	return (
		<LumenChart
			class="chart-box"
			options={{
				priceScales: {
					oscillator: { paneWeight: props.oscillatorWeight ?? 0.5, visible: true },
					volume: { paneWeight: 0.5, visible: true },
				},
				crosshair: { mode: 'nearest' },
			}}
			onReady={handleReady}
		/>
	);
}`,
		},
	],

	'custom-indicators': [
		{
			blockIndex: 1,
			match: 'chart.registerIndicators(',
			react: `import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

const moduleUrl = new URL('./my-indicators.js', import.meta.url);

export function CustomIndicatorChart({ bars }: { bars: OhlcColumns }) {
	const [chart, setChart] = useState<ChartApi | null>(null);

	useEffect(() => {
		if (chart === null) return;
		let cancelled = false;
		const candles = chart.addSeries('candlestick');
		candles.setData(bars);

		void chart.registerIndicators(moduleUrl).then(() => {
			if (!cancelled) {
				candles.addIndicator('momentum', { params: { period: 14 } });
			}
		});

		return () => {
			cancelled = true;
			chart.removeSeries(candles);
		};
	}, [chart, bars]);

	return <LumenChart ref={setChart} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue';

const props = defineProps<{ bars: OhlcColumns }>();
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const moduleUrl = new URL('./my-indicators.js', import.meta.url);
let unmounted = false;

onMounted(async () => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const candles = chart.addSeries('candlestick');
	candles.setData(props.bars);
	await chart.registerIndicators(moduleUrl);
	if (!unmounted) {
		candles.addIndicator('momentum', { params: { period: 14 } });
	}
});

onBeforeUnmount(() => {
	unmounted = true;
});
</script>

<template>
	<LumenChart ref="chartEl" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import type { OhlcColumns } from '@lumen-charts/core';
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';
	import { onDestroy } from 'svelte';

	let { bars }: { bars: OhlcColumns } = $props();
	const moduleUrl = new URL('./my-indicators.js', import.meta.url);
	let destroyed = false;
	onDestroy(() => {
		destroyed = true;
	});

	async function onReady(chart: ChartApi) {
		const candles = chart.addSeries('candlestick');
		candles.setData(bars);
		await chart.registerIndicators(moduleUrl);
		if (!destroyed) {
			candles.addIndicator('momentum', { params: { period: 14 } });
		}
	}
</script>

<div style="height: 420px" use:lumenChart={{ onReady }}></div>`,
			solid: `import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/solid';
import { onCleanup } from 'solid-js';

const moduleUrl = new URL('./my-indicators.js', import.meta.url);

export function CustomIndicatorChart(props: { bars: OhlcColumns }) {
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	const handleReady = async (chart: ChartApi) => {
		const candles = chart.addSeries('candlestick');
		candles.setData(props.bars);
		await chart.registerIndicators(moduleUrl);
		if (!disposed) {
			candles.addIndicator('momentum', { params: { period: 14 } });
		}
	};

	return <LumenChart class="chart-box" onReady={handleReady} />;
}`,
		},
	],

	'price-axes': [
		{
			blockIndex: 0,
			match: "priceScale: { mode: 'logarithmic' }",
			react: `import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

const options: DeepPartial<ChartOptions> = {
	// The default scale (id \`default\`), on which series go unless they name another.
	priceScale: { mode: 'logarithmic' },
	// Further scales by id. Without \`visible: true\` a scale is an overlay, with no axis of its own.
	priceScales: {
		compare: { visible: true, position: 'left', mode: 'percentage' },
		volume: { scaleMargins: { top: 0.8, bottom: 0 } },
	},
};

export function MultiScaleChart() {
	const [chart, setChart] = useState<ChartApi | null>(null);

	useEffect(() => {
		if (chart === null) return;
		const candles = chart.addSeries('candlestick', { minMove: 0.25 });
		const other = chart.addSeries('line', { priceScaleId: 'compare' });
		const volume = chart.addSeries('histogram', { priceScaleId: 'volume', color: '#26a69a80' });
		candles.addIndicator('rsi', { priceScaleId: 'oscillator' });

		other.applyOptions({ priceScaleId: 'default' }); // a series can change scales at any time
		chart.priceScale('compare').applyOptions({ invertScale: true });
		const y = candles.priceToCoordinate(101.25); // CSS pixels from the top of the shared plot, or null
		void y;

		return () => {
			chart.removeSeries(volume);
			chart.removeSeries(other);
			chart.removeSeries(candles);
		};
	}, [chart]);

	return <LumenChart ref={setChart} options={options} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/vue';
import { onMounted, useTemplateRef } from 'vue';

const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const options: DeepPartial<ChartOptions> = {
	priceScale: { mode: 'logarithmic' },
	priceScales: {
		compare: { visible: true, position: 'left', mode: 'percentage' },
		volume: { scaleMargins: { top: 0.8, bottom: 0 } },
	},
};

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const candles = chart.addSeries('candlestick', { minMove: 0.25 });
	const other = chart.addSeries('line', { priceScaleId: 'compare' });
	chart.addSeries('histogram', { priceScaleId: 'volume', color: '#26a69a80' });
	candles.addIndicator('rsi', { priceScaleId: 'oscillator' });

	other.applyOptions({ priceScaleId: 'default' });
	chart.priceScale('compare').applyOptions({ invertScale: true });
	const y = candles.priceToCoordinate(101.25);
	void y;
});
</script>

<template>
	<LumenChart ref="chartEl" :options="options" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import { lumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/svelte';

	const options: DeepPartial<ChartOptions> = {
		priceScale: { mode: 'logarithmic' },
		priceScales: {
			compare: { visible: true, position: 'left', mode: 'percentage' },
			volume: { scaleMargins: { top: 0.8, bottom: 0 } },
		},
	};

	function onReady(chart: ChartApi) {
		const candles = chart.addSeries('candlestick', { minMove: 0.25 });
		const other = chart.addSeries('line', { priceScaleId: 'compare' });
		chart.addSeries('histogram', { priceScaleId: 'volume', color: '#26a69a80' });
		candles.addIndicator('rsi', { priceScaleId: 'oscillator' });

		other.applyOptions({ priceScaleId: 'default' });
		chart.priceScale('compare').applyOptions({ invertScale: true });
		const y = candles.priceToCoordinate(101.25);
		void y;
	}
</script>

<div style="height: 420px" use:lumenChart={{ options, onReady }}></div>`,
			solid: `import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/solid';

const options: DeepPartial<ChartOptions> = {
	priceScale: { mode: 'logarithmic' },
	priceScales: {
		compare: { visible: true, position: 'left', mode: 'percentage' },
		volume: { scaleMargins: { top: 0.8, bottom: 0 } },
	},
};

export function MultiScaleChart() {
	const handleReady = (chart: ChartApi) => {
		const candles = chart.addSeries('candlestick', { minMove: 0.25 });
		const other = chart.addSeries('line', { priceScaleId: 'compare' });
		chart.addSeries('histogram', { priceScaleId: 'volume', color: '#26a69a80' });
		candles.addIndicator('rsi', { priceScaleId: 'oscillator' });

		other.applyOptions({ priceScaleId: 'default' });
		chart.priceScale('compare').applyOptions({ invertScale: true });
		const y = candles.priceToCoordinate(101.25);
		void y;
	};

	return <LumenChart class="chart-box" options={options} onReady={handleReady} />;
}`,
		},
	],

	'time-zones': [
		{
			blockIndex: 0,
			match: "timeZone: 'America/New_York'",
			react: `import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/react';
import { useEffect, useMemo, useState } from 'react';

export function SessionChart({ timeZone = 'America/New_York' }: { timeZone?: string }) {
	const [chart, setChart] = useState<ChartApi | null>(null);

	// Changing timeZone updates the axis wall clock through applyOptions.
	const options = useMemo<DeepPartial<ChartOptions>>(
		() => ({
			localization: { timeZone, locale: 'en-US' },
			sessions: {
				schedule: {
					timeZone: 'America/New_York', // exchange's zone; empty takes the chart's
					days: [1, 2, 3, 4, 5],
					hours: [
						{ start: '04:00', end: '09:30', kind: 'pre' },
						{ start: '09:30', end: '16:00' },
						{ start: '16:00', end: '20:00', kind: 'post' },
					],
					holidays: ['2024-12-25'],
				},
				breaks: { visible: true }, // a line at the first bar of each trading day
			},
		}),
		[timeZone],
	);

	useEffect(() => {
		if (chart === null) return;
		const now = Date.now();
		chart.timeScale().isInSession(now); // extended hours included
		chart.timeScale().sessionAt(now); // { index, kind, tradingDay } or null
	}, [chart, timeZone]);

	return <LumenChart ref={setChart} options={options} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/vue';
import { computed, onMounted, useTemplateRef } from 'vue';

const props = withDefaults(defineProps<{ timeZone?: string }>(), { timeZone: 'America/New_York' });
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');

const options = computed<DeepPartial<ChartOptions>>(() => ({
	localization: { timeZone: props.timeZone, locale: 'en-US' },
	sessions: {
		schedule: {
			timeZone: 'America/New_York',
			days: [1, 2, 3, 4, 5],
			hours: [
				{ start: '04:00', end: '09:30', kind: 'pre' },
				{ start: '09:30', end: '16:00' },
				{ start: '16:00', end: '20:00', kind: 'post' },
			],
			holidays: ['2024-12-25'],
		},
		breaks: { visible: true },
	},
}));

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const now = Date.now();
	chart.timeScale().isInSession(now);
	chart.timeScale().sessionAt(now);
});
</script>

<template>
	<LumenChart ref="chartEl" :options="options" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import { lumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/svelte';

	let { timeZone = 'America/New_York' }: { timeZone?: string } = $props();

	const options = $derived<DeepPartial<ChartOptions>>({
		localization: { timeZone, locale: 'en-US' },
		sessions: {
			schedule: {
				timeZone: 'America/New_York',
				days: [1, 2, 3, 4, 5],
				hours: [
					{ start: '04:00', end: '09:30', kind: 'pre' },
					{ start: '09:30', end: '16:00' },
					{ start: '16:00', end: '20:00', kind: 'post' },
				],
				holidays: ['2024-12-25'],
			},
			breaks: { visible: true },
		},
	});

	function onReady(chart: ChartApi) {
		const now = Date.now();
		chart.timeScale().isInSession(now);
		chart.timeScale().sessionAt(now);
	}
</script>

<div style="height: 420px" use:lumenChart={{ options, onReady }}></div>`,
			solid: `import { LumenChart, type ChartApi } from '@lumen-charts/solid';

export function SessionChart(props: { timeZone?: string }) {
	const handleReady = (chart: ChartApi) => {
		const now = Date.now();
		chart.timeScale().isInSession(now);
		chart.timeScale().sessionAt(now);
	};

	return (
		<LumenChart
			class="chart-box"
			options={{
				localization: { timeZone: props.timeZone ?? 'America/New_York', locale: 'en-US' },
				sessions: {
					schedule: {
						timeZone: 'America/New_York',
						days: [1, 2, 3, 4, 5],
						hours: [
							{ start: '04:00', end: '09:30', kind: 'pre' },
							{ start: '09:30', end: '16:00' },
							{ start: '16:00', end: '20:00', kind: 'post' },
						],
						holidays: ['2024-12-25'],
					},
					breaks: { visible: true },
				},
			}}
			onReady={handleReady}
		/>
	);
}`,
		},
	],

	drawings: [
		{
			blockIndex: 0,
			match: "drawings.startTool('trendLine'",
			react: `import type { DrawingApi } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

export function DrawingChart({ t1, t2 }: { t1: number; t2: number }) {
	const [chart, setChart] = useState<ChartApi | null>(null);
	const [selected, setSelected] = useState<DrawingApi | null>(null);

	useEffect(() => {
		if (chart === null) return;
		const drawings = chart.drawings();
		const zone = drawings.add({
			type: 'rectangle',
			points: [
				{ time: t1, price: 101.5 },
				{ time: t2, price: 99.2 },
			],
			options: { fillColor: 'rgba(38, 166, 154, 0.15)', locked: true },
		});
		zone.applyOptions({ text: 'Supply' });
		zone.bringToFront();

		const offChanged = drawings.subscribe('changed', drawing => save(drawing.toJSON()));
		const offSelected = drawings.subscribe('selected', setSelected);
		return () => {
			offChanged();
			offSelected();
			zone.remove();
		};
	}, [chart, t1, t2]);

	return (
		<>
			<button
				type="button"
				onClick={() => chart?.drawings().startTool('trendLine', { color: '#f5b83d', lineWidth: 2 })}
			>
				Draw trend line
			</button>
			{selected && <span>Selected: {selected.type}</span>}
			<LumenChart ref={setChart} style={{ height: 420 }} />
		</>
	);
}`,
			vue: `<script setup lang="ts">
import type { DrawingApi } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from 'vue';

const props = defineProps<{ t1: number; t2: number }>();
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const selected = shallowRef<DrawingApi | null>(null);
const cleanups: (() => void)[] = [];

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const drawings = chart.drawings();
	const zone = drawings.add({
		type: 'rectangle',
		points: [
			{ time: props.t1, price: 101.5 },
			{ time: props.t2, price: 99.2 },
		],
		options: { fillColor: 'rgba(38, 166, 154, 0.15)', locked: true },
	});
	zone.applyOptions({ text: 'Supply' });
	zone.bringToFront();

	cleanups.push(
		drawings.subscribe('changed', drawing => save(drawing.toJSON())),
		drawings.subscribe('selected', drawing => {
			selected.value = drawing;
		}),
	);
});

onBeforeUnmount(() => {
	for (const stop of cleanups) stop();
});

function startTrendLine() {
	chartEl.value?.chart?.drawings().startTool('trendLine', { color: '#f5b83d', lineWidth: 2 });
}
</script>

<template>
	<button type="button" @click="startTrendLine">Draw trend line</button>
	<span v-if="selected">Selected: {{ selected.type }}</span>
	<LumenChart ref="chartEl" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import type { DrawingApi } from '@lumen-charts/core';
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';
	import { onDestroy } from 'svelte';

	let { t1, t2 }: { t1: number; t2: number } = $props();
	let chart = $state<ChartApi | null>(null);
	let selected = $state<DrawingApi | null>(null);
	const cleanups: (() => void)[] = [];

	function onReady(instance: ChartApi) {
		chart = instance;
		const drawings = instance.drawings();
		const zone = drawings.add({
			type: 'rectangle',
			points: [
				{ time: t1, price: 101.5 },
				{ time: t2, price: 99.2 },
			],
			options: { fillColor: 'rgba(38, 166, 154, 0.15)', locked: true },
		});
		zone.applyOptions({ text: 'Supply' });
		zone.bringToFront();

		cleanups.push(
			drawings.subscribe('changed', drawing => save(drawing.toJSON())),
			drawings.subscribe('selected', drawing => {
				selected = drawing;
			}),
		);
	}

	onDestroy(() => {
		for (const stop of cleanups) stop();
	});
</script>

<button type="button" onclick={() => chart?.drawings().startTool('trendLine', { color: '#f5b83d', lineWidth: 2 })}>
	Draw trend line
</button>
{#if selected}<span>Selected: {selected.type}</span>{/if}
<div style="height: 420px" use:lumenChart={{ onReady }}></div>`,
			solid: `import type { DrawingApi } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/solid';
import { createSignal, onCleanup, Show } from 'solid-js';

export function DrawingChart(props: { t1: number; t2: number }) {
	let chart: ChartApi | undefined;
	const [selected, setSelected] = createSignal<DrawingApi | null>(null);

	const handleReady = (instance: ChartApi) => {
		chart = instance;
		const drawings = instance.drawings();
		const zone = drawings.add({
			type: 'rectangle',
			points: [
				{ time: props.t1, price: 101.5 },
				{ time: props.t2, price: 99.2 },
			],
			options: { fillColor: 'rgba(38, 166, 154, 0.15)', locked: true },
		});
		zone.applyOptions({ text: 'Supply' });
		zone.bringToFront();

		const offChanged = drawings.subscribe('changed', drawing => save(drawing.toJSON()));
		const offSelected = drawings.subscribe('selected', setSelected);
		onCleanup(() => {
			offChanged();
			offSelected();
		});
	};

	return (
		<>
			<button
				type="button"
				onClick={() => chart?.drawings().startTool('trendLine', { color: '#f5b83d', lineWidth: 2 })}
			>
				Draw trend line
			</button>
			<Show when={selected()}>{drawing => <span>Selected: {drawing().type}</span>}</Show>
			<LumenChart class="chart-box" onReady={handleReady} />
		</>
	);
}`,
		},
	],

	primitives: [
		{
			blockIndex: 0,
			match: 'chart.attachPrimitive(new SessionBox',
			react: `import type { DrawTarget, OhlcColumns, SeriesItems } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/react';
import { useEffect, useState } from 'react';
// Uses the same SessionBox PanePrimitive class shown in the Vanilla tab.

export function PrimitiveChart({ bars, open, close }: { bars: OhlcColumns; open: number; close: number }) {
	const [chart, setChart] = useState<ChartApi | null>(null);

	useEffect(() => {
		if (chart === null) return;
		const candles = chart.addSeries('candlestick');
		candles.setData(bars);

		const box = new SessionBox(open, close);
		chart.attachPrimitive(box);

		const rsi = candles.addIndicator('rsi');
		rsi.output().setRenderer({
			draw({ context }: DrawTarget, items: SeriesItems) {
				for (let i = 0; i < items.count; i++) {
					context.fillRect(items.x[i] - 1, items.yClose[i] - 1, 2, 2);
				}
			},
		});

		return () => {
			chart.detachPrimitive(box);
			chart.removeSeries(candles);
		};
	}, [chart, bars, open, close]);

	return <LumenChart ref={setChart} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import type { DrawTarget, OhlcColumns, SeriesItems } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue';
// Uses the same SessionBox PanePrimitive class shown in the Vanilla tab.

const props = defineProps<{ bars: OhlcColumns; open: number; close: number }>();
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
let box: SessionBox | null = null;

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const candles = chart.addSeries('candlestick');
	candles.setData(props.bars);

	box = new SessionBox(props.open, props.close);
	chart.attachPrimitive(box);

	const rsi = candles.addIndicator('rsi');
	rsi.output().setRenderer({
		draw({ context }: DrawTarget, items: SeriesItems) {
			for (let i = 0; i < items.count; i++) {
				context.fillRect(items.x[i] - 1, items.yClose[i] - 1, 2, 2);
			}
		},
	});
});

onBeforeUnmount(() => {
	if (box) chartEl.value?.chart?.detachPrimitive(box);
});
</script>

<template>
	<LumenChart ref="chartEl" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import type { DrawTarget, OhlcColumns, SeriesItems } from '@lumen-charts/core';
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';
	// Uses the same SessionBox PanePrimitive class shown in the Vanilla tab.

	let { bars, open, close }: { bars: OhlcColumns; open: number; close: number } = $props();

	function onReady(chart: ChartApi) {
		const candles = chart.addSeries('candlestick');
		candles.setData(bars);

		chart.attachPrimitive(new SessionBox(open, close));

		const rsi = candles.addIndicator('rsi');
		rsi.output().setRenderer({
			draw({ context }: DrawTarget, items: SeriesItems) {
				for (let i = 0; i < items.count; i++) {
					context.fillRect(items.x[i] - 1, items.yClose[i] - 1, 2, 2);
				}
			},
		});
	}
</script>

<div style="height: 420px" use:lumenChart={{ onReady }}></div>`,
			solid: `import type { DrawTarget, OhlcColumns, SeriesItems } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/solid';
// Uses the same SessionBox PanePrimitive class shown in the Vanilla tab.

export function PrimitiveChart(props: { bars: OhlcColumns; open: number; close: number }) {
	const handleReady = (chart: ChartApi) => {
		const candles = chart.addSeries('candlestick');
		candles.setData(props.bars);

		chart.attachPrimitive(new SessionBox(props.open, props.close));

		const rsi = candles.addIndicator('rsi');
		rsi.output().setRenderer({
			draw({ context }: DrawTarget, items: SeriesItems) {
				for (let i = 0; i < items.count; i++) {
					context.fillRect(items.x[i] - 1, items.yClose[i] - 1, 2, 2);
				}
			},
		});
	};

	return <LumenChart class="chart-box" onReady={handleReady} />;
}`,
		},
	],

	'heatmap-scatter': [
		{
			blockIndex: 0,
			match: "chart.addSeries('scatter'",
			react: `import type { HeatmapData, OhlcColumns, ScatterData } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

export function OrderBookChart({
	bars,
	tradeData,
	bookData,
}: {
	bars: OhlcColumns;
	tradeData: ScatterData;
	bookData: HeatmapData;
}) {
	const [chart, setChart] = useState<ChartApi | null>(null);

	useEffect(() => {
		if (chart === null) return;
		const candles = chart.addSeries('candlestick');
		candles.setData(bars);

		// Trades: points at any time and price, colored by size.
		const trades = chart.addSeries('scatter', { pointSize: 3, palette: 'turbo', barAlign: 'start' });
		trades.setData(tradeData);

		// Order book: one column of resting size per snapshot, on a grid of prices.
		const book = chart.addSeries('heatmap', { palette: 'heat', valueScale: 'log' });
		book.setData(bookData);

		// Density-colored scatter overlay.
		const flow = chart.addSeries('scatter', { colorBy: 'density', palette: 'inferno', valueScale: 'log' });

		return () => {
			chart.removeSeries(flow);
			chart.removeSeries(book);
			chart.removeSeries(trades);
			chart.removeSeries(candles);
		};
	}, [chart, bars, tradeData, bookData]);

	return <LumenChart ref={setChart} style={{ height: 440 }} />;
}`,
			vue: `<script setup lang="ts">
import type { HeatmapData, OhlcColumns, ScatterData } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onMounted, useTemplateRef } from 'vue';

const props = defineProps<{ bars: OhlcColumns; tradeData: ScatterData; bookData: HeatmapData }>();
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const candles = chart.addSeries('candlestick');
	candles.setData(props.bars);

	const trades = chart.addSeries('scatter', { pointSize: 3, palette: 'turbo', barAlign: 'start' });
	trades.setData(props.tradeData);

	const book = chart.addSeries('heatmap', { palette: 'heat', valueScale: 'log' });
	book.setData(props.bookData);

	chart.addSeries('scatter', { colorBy: 'density', palette: 'inferno', valueScale: 'log' });
});
</script>

<template>
	<LumenChart ref="chartEl" style="height: 440px" />
</template>`,
			svelte: `<script lang="ts">
	import type { HeatmapData, OhlcColumns, ScatterData } from '@lumen-charts/core';
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';

	let { bars, tradeData, bookData }: { bars: OhlcColumns; tradeData: ScatterData; bookData: HeatmapData } = $props();

	function onReady(chart: ChartApi) {
		const candles = chart.addSeries('candlestick');
		candles.setData(bars);

		const trades = chart.addSeries('scatter', { pointSize: 3, palette: 'turbo', barAlign: 'start' });
		trades.setData(tradeData);

		const book = chart.addSeries('heatmap', { palette: 'heat', valueScale: 'log' });
		book.setData(bookData);

		chart.addSeries('scatter', { colorBy: 'density', palette: 'inferno', valueScale: 'log' });
	}
</script>

<div style="height: 440px" use:lumenChart={{ onReady }}></div>`,
			solid: `import type { HeatmapData, OhlcColumns, ScatterData } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/solid';

export function OrderBookChart(props: { bars: OhlcColumns; tradeData: ScatterData; bookData: HeatmapData }) {
	const handleReady = (chart: ChartApi) => {
		const candles = chart.addSeries('candlestick');
		candles.setData(props.bars);

		const trades = chart.addSeries('scatter', { pointSize: 3, palette: 'turbo', barAlign: 'start' });
		trades.setData(props.tradeData);

		const book = chart.addSeries('heatmap', { palette: 'heat', valueScale: 'log' });
		book.setData(props.bookData);

		chart.addSeries('scatter', { colorBy: 'density', palette: 'inferno', valueScale: 'log' });
	};

	return <LumenChart class="chart-box" onReady={handleReady} />;
}`,
		},
		{
			blockIndex: 2,
			match: 'getMarks:',
			react: `import type { ScatterData } from '@lumen-charts/core';
import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

const options: DeepPartial<ChartOptions> = { memoryLimit: 64 * 1024 * 1024 };

export function MarkDatafeedChart({ symbol, history }: { symbol: string; history: ScatterData }) {
	const [chart, setChart] = useState<ChartApi | null>(null);

	useEffect(() => {
		if (chart === null) return;
		const trades = chart.addSeries('scatter', {
			datafeed: { getMarks: ({ from, to, signal }) => fetchTrades(symbol, from, to, { signal }) },
		});
		trades.setData(history);
		return () => chart.removeSeries(trades);
	}, [chart, symbol, history]);

	return <LumenChart ref={setChart} options={options} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import type { ScatterData } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onMounted, useTemplateRef } from 'vue';

const props = defineProps<{ symbol: string; history: ScatterData }>();
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const options = { memoryLimit: 64 * 1024 * 1024 };

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const trades = chart.addSeries('scatter', {
		datafeed: { getMarks: ({ from, to, signal }) => fetchTrades(props.symbol, from, to, { signal }) },
	});
	trades.setData(props.history);
});
</script>

<template>
	<LumenChart ref="chartEl" :options="options" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import type { ScatterData } from '@lumen-charts/core';
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';

	let { symbol, history }: { symbol: string; history: ScatterData } = $props();

	function onReady(chart: ChartApi) {
		const trades = chart.addSeries('scatter', {
			datafeed: { getMarks: ({ from, to, signal }) => fetchTrades(symbol, from, to, { signal }) },
		});
		trades.setData(history);
	}
</script>

<div style="height: 420px" use:lumenChart={{ options: { memoryLimit: 64 * 1024 * 1024 }, onReady }}></div>`,
			solid: `import type { ScatterData } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/solid';

export function MarkDatafeedChart(props: { symbol: string; history: ScatterData }) {
	const handleReady = (chart: ChartApi) => {
		const trades = chart.addSeries('scatter', {
			datafeed: { getMarks: ({ from, to, signal }) => fetchTrades(props.symbol, from, to, { signal }) },
		});
		trades.setData(props.history);
	};

	return <LumenChart class="chart-box" options={{ memoryLimit: 64 * 1024 * 1024 }} onReady={handleReady} />;
}`,
		},
		{
			blockIndex: 5,
			match: "markRenderer: 'webgpu'",
			react: `import type { HeatmapData, MarkRenderer, ScatterData } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/react';
import { useEffect, useMemo, useState } from 'react';

export function MarkBackendChart({ points, grid }: { points: ScatterData; grid: HeatmapData }) {
	const [chart, setChart] = useState<ChartApi | null>(null);
	const [markRenderer, setMarkRenderer] = useState<MarkRenderer>('webgpu');
	const options = useMemo(() => ({ markRenderer }), [markRenderer]);

	useEffect(() => {
		if (chart === null) return;
		let cancelled = false;
		const trades = chart.addSeries('scatter', { pointSize: 1.5 });
		const depth = chart.addSeries('heatmap');
		trades.setData(points);
		depth.setData(grid);
		void chart.whenIdle().then(() => {
			if (!cancelled) console.log(trades.renderer(), depth.renderer());
		});
		return () => {
			cancelled = true;
			chart.removeSeries(depth);
			chart.removeSeries(trades);
		};
	}, [chart, points, grid]);

	return (
		<>
			<button type="button" onClick={() => setMarkRenderer('canvas2d')}>
				Use Canvas 2D
			</button>
			<LumenChart ref={setChart} options={options} style={{ height: 420 }} />
		</>
	);
}`,
			vue: `<script setup lang="ts">
import type { HeatmapData, MarkRenderer, ScatterData } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { computed, onMounted, ref, useTemplateRef } from 'vue';

const props = defineProps<{ points: ScatterData; grid: HeatmapData }>();
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const markRenderer = ref<MarkRenderer>('webgpu');
const options = computed(() => ({ markRenderer: markRenderer.value }));

onMounted(async () => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const trades = chart.addSeries('scatter', { pointSize: 1.5 });
	const depth = chart.addSeries('heatmap');
	trades.setData(props.points);
	depth.setData(props.grid);
	await chart.whenIdle();
	console.log(trades.renderer(), depth.renderer());
});
</script>

<template>
	<button type="button" @click="markRenderer = 'canvas2d'">Use Canvas 2D</button>
	<LumenChart ref="chartEl" :options="options" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import type { HeatmapData, MarkRenderer, ScatterData } from '@lumen-charts/core';
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';

	let { points, grid }: { points: ScatterData; grid: HeatmapData } = $props();
	let markRenderer = $state<MarkRenderer>('webgpu');

	async function onReady(chart: ChartApi) {
		const trades = chart.addSeries('scatter', { pointSize: 1.5 });
		const depth = chart.addSeries('heatmap');
		trades.setData(points);
		depth.setData(grid);
		await chart.whenIdle();
		console.log(trades.renderer(), depth.renderer());
	}
</script>

<button type="button" onclick={() => (markRenderer = 'canvas2d')}>Use Canvas 2D</button>
<div style="height: 420px" use:lumenChart={{ options: { markRenderer }, onReady }}></div>`,
			solid: `import type { HeatmapData, MarkRenderer, ScatterData } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/solid';
import { createSignal } from 'solid-js';

export function MarkBackendChart(props: { points: ScatterData; grid: HeatmapData }) {
	const [markRenderer, setMarkRenderer] = createSignal<MarkRenderer>('webgpu');

	const handleReady = async (chart: ChartApi) => {
		const trades = chart.addSeries('scatter', { pointSize: 1.5 });
		const depth = chart.addSeries('heatmap');
		trades.setData(props.points);
		depth.setData(props.grid);
		await chart.whenIdle();
		console.log(trades.renderer(), depth.renderer());
	};

	return (
		<>
			<button type="button" onClick={() => setMarkRenderer('canvas2d')}>
				Use Canvas 2D
			</button>
			<LumenChart class="chart-box" options={{ markRenderer: markRenderer() }} onReady={handleReady} />
		</>
	);
}`,
		},
	],

	events: [
		{
			blockIndex: 0,
			match: "chart.subscribe('crosshairMove'",
			react: `import { LumenChart, type ChartApi } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

export function LegendChart() {
	const [chart, setChart] = useState<ChartApi | null>(null);
	const [legend, setLegend] = useState('');

	useEffect(() => {
		if (chart === null) return;
		const offCrosshair = chart.subscribe('crosshairMove', event => {
			const bar = event.values.get('btc');
			setLegend(bar && 'close' in bar && event.time !== null ? \`\${formatTime(event.time)} \${bar.close}\` : '');
		});
		const offClick = chart.subscribe('click', event => {
			if (event.time !== null) console.log('clicked the bar at', event.time);
		});
		const offRange = chart.timeScale().subscribe('visibleTimeRangeChange', range => {
			if (range !== null) url.searchParams.set('view', \`\${range.from}-\${range.to}\`);
		});
		return () => {
			offCrosshair();
			offClick();
			offRange();
		};
	}, [chart]);

	return (
		<>
			<output>{legend}</output>
			<LumenChart ref={setChart} style={{ height: 420 }} />
		</>
	);
}`,
			vue: `<script setup lang="ts">
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';

const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const legend = ref('');
const cleanups: (() => void)[] = [];

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	cleanups.push(
		chart.subscribe('crosshairMove', event => {
			const bar = event.values.get('btc');
			legend.value = bar && 'close' in bar && event.time !== null ? \`\${formatTime(event.time)} \${bar.close}\` : '';
		}),
		chart.subscribe('click', event => {
			if (event.time !== null) console.log('clicked the bar at', event.time);
		}),
		chart.timeScale().subscribe('visibleTimeRangeChange', range => {
			if (range !== null) url.searchParams.set('view', \`\${range.from}-\${range.to}\`);
		}),
	);
});

onBeforeUnmount(() => {
	for (const stop of cleanups) stop();
});
</script>

<template>
	<output>{{ legend }}</output>
	<LumenChart ref="chartEl" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';
	import { onDestroy } from 'svelte';

	let legend = $state('');
	const cleanups: (() => void)[] = [];

	function onReady(chart: ChartApi) {
		cleanups.push(
			chart.subscribe('crosshairMove', event => {
				const bar = event.values.get('btc');
				legend = bar && 'close' in bar && event.time !== null ? \`\${formatTime(event.time)} \${bar.close}\` : '';
			}),
			chart.subscribe('click', event => {
				if (event.time !== null) console.log('clicked the bar at', event.time);
			}),
			chart.timeScale().subscribe('visibleTimeRangeChange', range => {
				if (range !== null) url.searchParams.set('view', \`\${range.from}-\${range.to}\`);
			}),
		);
	}

	onDestroy(() => {
		for (const stop of cleanups) stop();
	});
</script>

<output>{legend}</output>
<div style="height: 420px" use:lumenChart={{ onReady }}></div>`,
			solid: `import { LumenChart, type ChartApi } from '@lumen-charts/solid';
import { createSignal, onCleanup } from 'solid-js';

export function LegendChart() {
	const [legend, setLegend] = createSignal('');

	const handleReady = (chart: ChartApi) => {
		const offCrosshair = chart.subscribe('crosshairMove', event => {
			const bar = event.values.get('btc');
			setLegend(bar && 'close' in bar && event.time !== null ? \`\${formatTime(event.time)} \${bar.close}\` : '');
		});
		const offClick = chart.subscribe('click', event => {
			if (event.time !== null) console.log('clicked the bar at', event.time);
		});
		const offRange = chart.timeScale().subscribe('visibleTimeRangeChange', range => {
			if (range !== null) url.searchParams.set('view', \`\${range.from}-\${range.to}\`);
		});
		onCleanup(() => {
			offCrosshair();
			offClick();
			offRange();
		});
	};

	return (
		<>
			<output>{legend()}</output>
			<LumenChart class="chart-box" onReady={handleReady} />
		</>
	);
}`,
		},
		{
			blockIndex: 6,
			match: 'const charts = [prices, volume];',
			react: `import { LumenChart, type ChartApi } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

export function SyncedCharts() {
	const [prices, setPrices] = useState<ChartApi | null>(null);
	const [volume, setVolume] = useState<ChartApi | null>(null);

	useEffect(() => {
		if (prices === null || volume === null) return;
		const charts = [prices, volume];
		const cleanups = charts.flatMap(chart => {
			const others = charts.filter(other => other !== chart);
			return [
				chart.subscribe('crosshairMove', event => {
					if (event.source === 'api') return;
					for (const other of others) {
						if (event.time === null) other.clearCrosshairPosition();
						else other.setCrosshairPosition(event.time, null);
					}
				}),
				chart.timeScale().subscribe('visibleTimeRangeChange', range => {
					if (range !== null) for (const other of others) other.timeScale().setVisibleRange(range);
				}),
			];
		});
		return () => {
			for (const stop of cleanups) stop();
		};
	}, [prices, volume]);

	return (
		<>
			<LumenChart ref={setPrices} style={{ height: 280 }} />
			<LumenChart ref={setVolume} style={{ height: 140 }} />
		</>
	);
}`,
			vue: `<script setup lang="ts">
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue';

const pricesEl = useTemplateRef<{ chart: ChartApi | null }>('pricesEl');
const volumeEl = useTemplateRef<{ chart: ChartApi | null }>('volumeEl');
const cleanups: (() => void)[] = [];

onMounted(() => {
	const prices = pricesEl.value?.chart;
	const volume = volumeEl.value?.chart;
	if (!prices || !volume) return;
	const charts = [prices, volume];
	for (const chart of charts) {
		const others = charts.filter(other => other !== chart);
		cleanups.push(
			chart.subscribe('crosshairMove', event => {
				if (event.source === 'api') return;
				for (const other of others) {
					if (event.time === null) other.clearCrosshairPosition();
					else other.setCrosshairPosition(event.time, null);
				}
			}),
			chart.timeScale().subscribe('visibleTimeRangeChange', range => {
				if (range !== null) for (const other of others) other.timeScale().setVisibleRange(range);
			}),
		);
	}
});

onBeforeUnmount(() => {
	for (const stop of cleanups) stop();
});
</script>

<template>
	<LumenChart ref="pricesEl" style="height: 280px" />
	<LumenChart ref="volumeEl" style="height: 140px" />
</template>`,
			svelte: `<script lang="ts">
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';

	let prices = $state<ChartApi | null>(null);
	let volume = $state<ChartApi | null>(null);

	$effect(() => {
		if (prices === null || volume === null) return;
		const charts = [prices, volume];
		const cleanups = charts.flatMap(chart => {
			const others = charts.filter(other => other !== chart);
			return [
				chart.subscribe('crosshairMove', event => {
					if (event.source === 'api') return;
					for (const other of others) {
						if (event.time === null) other.clearCrosshairPosition();
						else other.setCrosshairPosition(event.time, null);
					}
				}),
				chart.timeScale().subscribe('visibleTimeRangeChange', range => {
					if (range !== null) for (const other of others) other.timeScale().setVisibleRange(range);
				}),
			];
		});
		return () => {
			for (const stop of cleanups) stop();
		};
	});
</script>

<div style="height: 280px" use:lumenChart={{ onReady: c => (prices = c) }}></div>
<div style="height: 140px" use:lumenChart={{ onReady: c => (volume = c) }}></div>`,
			solid: `import { LumenChart, type ChartApi } from '@lumen-charts/solid';
import { createEffect, createSignal, onCleanup } from 'solid-js';

export function SyncedCharts() {
	const [prices, setPrices] = createSignal<ChartApi | null>(null);
	const [volume, setVolume] = createSignal<ChartApi | null>(null);

	createEffect(() => {
		const p = prices();
		const v = volume();
		if (p === null || v === null) return;
		const charts = [p, v];
		const cleanups = charts.flatMap(chart => {
			const others = charts.filter(other => other !== chart);
			return [
				chart.subscribe('crosshairMove', event => {
					if (event.source === 'api') return;
					for (const other of others) {
						if (event.time === null) other.clearCrosshairPosition();
						else other.setCrosshairPosition(event.time, null);
					}
				}),
				chart.timeScale().subscribe('visibleTimeRangeChange', range => {
					if (range !== null) for (const other of others) other.timeScale().setVisibleRange(range);
				}),
			];
		});
		onCleanup(() => {
			for (const stop of cleanups) stop();
		});
	});

	return (
		<>
			<LumenChart class="chart-price" onReady={setPrices} />
			<LumenChart class="chart-volume" onReady={setVolume} />
		</>
	);
}`,
		},
	],

	datafeed: [
		{
			blockIndex: 0,
			match: 'getBars:',
			react: `import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

const options: DeepPartial<ChartOptions> = { memoryLimit: 64 * 1024 * 1024 };

export function DatafeedChart({ symbol, history }: { symbol: string; history: OhlcColumns }) {
	const [chart, setChart] = useState<ChartApi | null>(null);

	useEffect(() => {
		if (chart === null) return;
		const candles = chart.addSeries('candlestick', {
			datafeed: {
				getBars: ({ from, to, signal }) => fetchBars(symbol, '1m', from, to, { signal }),
			},
		});
		candles.setData(history);
		return () => chart.removeSeries(candles);
	}, [chart, symbol, history]);

	return <LumenChart ref={setChart} options={options} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onMounted, useTemplateRef } from 'vue';

const props = defineProps<{ symbol: string; history: OhlcColumns }>();
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const options = { memoryLimit: 64 * 1024 * 1024 };

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const candles = chart.addSeries('candlestick', {
		datafeed: {
			getBars: ({ from, to, signal }) => fetchBars(props.symbol, '1m', from, to, { signal }),
		},
	});
	candles.setData(props.history);
});
</script>

<template>
	<LumenChart ref="chartEl" :options="options" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import type { OhlcColumns } from '@lumen-charts/core';
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';

	let { symbol, history }: { symbol: string; history: OhlcColumns } = $props();

	function onReady(chart: ChartApi) {
		const candles = chart.addSeries('candlestick', {
			datafeed: {
				getBars: ({ from, to, signal }) => fetchBars(symbol, '1m', from, to, { signal }),
			},
		});
		candles.setData(history);
	}
</script>

<div style="height: 420px" use:lumenChart={{ options: { memoryLimit: 64 * 1024 * 1024 }, onReady }}></div>`,
			solid: `import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/solid';

export function DatafeedChart(props: { symbol: string; history: OhlcColumns }) {
	const handleReady = (chart: ChartApi) => {
		const candles = chart.addSeries('candlestick', {
			datafeed: {
				getBars: ({ from, to, signal }) => fetchBars(props.symbol, '1m', from, to, { signal }),
			},
		});
		candles.setData(props.history);
	};

	return <LumenChart class="chart-box" options={{ memoryLimit: 64 * 1024 * 1024 }} onReady={handleReady} />;
}`,
		},
	],

	'several-charts': [
		{
			blockIndex: 0,
			match: 'setMaxWorkers(2)',
			react: `import { setMaxWorkers } from '@lumen-charts/core';
import { LumenChart } from '@lumen-charts/react';

setMaxWorkers(2); // optional, before any chart mounts

export function ChartGrid({ symbols }: { symbols: string[] }) {
	return (
		<div className="chart-grid">
			{symbols.map(symbol => (
				<LumenChart key={symbol} style={{ height: 260 }} />
			))}
		</div>
	);
}`,
			vue: `<script setup lang="ts">
import { setMaxWorkers } from '@lumen-charts/core';
import { LumenChart } from '@lumen-charts/vue';

setMaxWorkers(2); // optional, before any chart mounts
defineProps<{ symbols: string[] }>();
</script>

<template>
	<div class="chart-grid">
		<LumenChart v-for="symbol in symbols" :key="symbol" style="height: 260px" />
	</div>
</template>`,
			svelte: `<script lang="ts">
	import { setMaxWorkers } from '@lumen-charts/core';
	import { lumenChart } from '@lumen-charts/svelte';

	setMaxWorkers(2); // optional, before any chart mounts
	let { symbols }: { symbols: string[] } = $props();
</script>

<div class="chart-grid">
	{#each symbols as symbol (symbol)}
		<div style="height: 260px" use:lumenChart></div>
	{/each}
</div>`,
			solid: `import { setMaxWorkers } from '@lumen-charts/core';
import { LumenChart } from '@lumen-charts/solid';
import { For } from 'solid-js';

setMaxWorkers(2); // optional, before any chart mounts

export function ChartGrid(props: { symbols: string[] }) {
	return (
		<div class="chart-grid">
			<For each={props.symbols}>{() => <LumenChart class="chart-cell" />}</For>
		</div>
	);
}`,
		},
	],

	'save-restore': [
		{
			blockIndex: 0,
			match: 'chart.saveState()',
			react: `import { LumenChart, type ChartApi } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

export function PersistedChart() {
	const [chart, setChart] = useState<ChartApi | null>(null);

	useEffect(() => {
		if (chart === null) return;
		const saved = localStorage.getItem('layout');
		if (saved === null) return;
		let cancelled = false;

		chart.restoreState(JSON.parse(saved));
		void Promise.all(
			chart.series().map(async series => {
				const bars = await loadBars(series.id);
				if (!cancelled) series.setData(bars);
			}),
		);
		return () => {
			cancelled = true;
		};
	}, [chart]);

	const handleSave = () => {
		if (chart !== null) {
			localStorage.setItem('layout', JSON.stringify(chart.saveState()));
		}
	};

	return (
		<>
			<button type="button" onClick={handleSave}>
				Save layout
			</button>
			<LumenChart ref={setChart} style={{ height: 420 }} />
		</>
	);
}`,
			vue: `<script setup lang="ts">
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onMounted, useTemplateRef } from 'vue';

const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');

onMounted(async () => {
	const chart = chartEl.value?.chart;
	const saved = localStorage.getItem('layout');
	if (!chart || saved === null) return;

	chart.restoreState(JSON.parse(saved));
	for (const series of chart.series()) {
		series.setData(await loadBars(series.id));
	}
});

function saveLayout() {
	const chart = chartEl.value?.chart;
	if (chart) localStorage.setItem('layout', JSON.stringify(chart.saveState()));
}
</script>

<template>
	<button type="button" @click="saveLayout">Save layout</button>
	<LumenChart ref="chartEl" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';

	let chart = $state<ChartApi | null>(null);

	async function onReady(instance: ChartApi) {
		chart = instance;
		const saved = localStorage.getItem('layout');
		if (saved === null) return;

		instance.restoreState(JSON.parse(saved));
		for (const series of instance.series()) {
			series.setData(await loadBars(series.id));
		}
	}

	function saveLayout() {
		if (chart !== null) localStorage.setItem('layout', JSON.stringify(chart.saveState()));
	}
</script>

<button type="button" onclick={saveLayout}>Save layout</button>
<div style="height: 420px" use:lumenChart={{ onReady }}></div>`,
			solid: `import { LumenChart, type ChartApi } from '@lumen-charts/solid';

export function PersistedChart() {
	let chart: ChartApi | undefined;

	const handleReady = async (instance: ChartApi) => {
		chart = instance;
		const saved = localStorage.getItem('layout');
		if (saved === null) return;

		instance.restoreState(JSON.parse(saved));
		for (const series of instance.series()) {
			series.setData(await loadBars(series.id));
		}
	};

	const handleSave = () => {
		if (chart) localStorage.setItem('layout', JSON.stringify(chart.saveState()));
	};

	return (
		<>
			<button type="button" onClick={handleSave}>
				Save layout
			</button>
			<LumenChart class="chart-box" onReady={handleReady} />
		</>
	);
}`,
		},
	],

	accessibility: [
		{
			blockIndex: 0,
			match: "label: 'EUR/USD hourly'",
			react: `import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

const options: DeepPartial<ChartOptions> = {
	accessibility: { label: 'EUR/USD hourly', description: 'Prices in US dollars per euro.' },
	localization: { timeZone: 'Europe/Berlin', locale: 'de-DE' },
};

export function AccessibleChart({ bars }: { bars: OhlcColumns }) {
	const [chart, setChart] = useState<ChartApi | null>(null);

	useEffect(() => {
		if (chart === null) return;
		const bid = chart.addSeries('candlestick', { id: 'Bid', precision: 5 });
		bid.setData(bars);
		return () => chart.removeSeries(bid);
	}, [chart, bars]);

	return <LumenChart ref={setChart} options={options} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/vue';
import { onMounted, useTemplateRef } from 'vue';

const props = defineProps<{ bars: OhlcColumns }>();
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const options: DeepPartial<ChartOptions> = {
	accessibility: { label: 'EUR/USD hourly', description: 'Prices in US dollars per euro.' },
	localization: { timeZone: 'Europe/Berlin', locale: 'de-DE' },
};

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	chart.addSeries('candlestick', { id: 'Bid', precision: 5 }).setData(props.bars);
});
</script>

<template>
	<LumenChart ref="chartEl" :options="options" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import type { OhlcColumns } from '@lumen-charts/core';
	import { lumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/svelte';

	let { bars }: { bars: OhlcColumns } = $props();
	const options: DeepPartial<ChartOptions> = {
		accessibility: { label: 'EUR/USD hourly', description: 'Prices in US dollars per euro.' },
		localization: { timeZone: 'Europe/Berlin', locale: 'de-DE' },
	};

	function onReady(chart: ChartApi) {
		chart.addSeries('candlestick', { id: 'Bid', precision: 5 }).setData(bars);
	}
</script>

<div style="height: 420px" use:lumenChart={{ options, onReady }}></div>`,
			solid: `import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi, type ChartOptions, type DeepPartial } from '@lumen-charts/solid';

const options: DeepPartial<ChartOptions> = {
	accessibility: { label: 'EUR/USD hourly', description: 'Prices in US dollars per euro.' },
	localization: { timeZone: 'Europe/Berlin', locale: 'de-DE' },
};

export function AccessibleChart(props: { bars: OhlcColumns }) {
	const handleReady = (chart: ChartApi) => {
		chart.addSeries('candlestick', { id: 'Bid', precision: 5 }).setData(props.bars);
	};

	return <LumenChart class="chart-box" options={options} onReady={handleReady} />;
}`,
		},
		{
			blockIndex: 1,
			match: 'keyBindings:',
			react: `import { LumenChart, type ChartOptions, type DeepPartial } from '@lumen-charts/react';

const options: DeepPartial<ChartOptions> = {
	accessibility: {
		keyBindings: {
			previous: ['Shift+J'], // Shift+J or the standard arrows
			next: ['Shift+K'],
			fitContent: ['Ctrl+Shift+F', 'Cmd+Shift+F'],
			refresh: ['Option+[KeyR]'], // physical R position, on any layout
			zoomOut: [], // release the default minus shortcut
		},
	},
};

export function CustomShortcutsChart() {
	return <LumenChart options={options} style={{ height: 420 }} />;
}`,
			vue: `<script setup lang="ts">
import { LumenChart, type ChartOptions, type DeepPartial } from '@lumen-charts/vue';

const options: DeepPartial<ChartOptions> = {
	accessibility: {
		keyBindings: {
			previous: ['Shift+J'],
			next: ['Shift+K'],
			fitContent: ['Ctrl+Shift+F', 'Cmd+Shift+F'],
			refresh: ['Option+[KeyR]'],
			zoomOut: [],
		},
	},
};
</script>

<template>
	<LumenChart :options="options" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import { lumenChart, type ChartOptions, type DeepPartial } from '@lumen-charts/svelte';

	const options: DeepPartial<ChartOptions> = {
		accessibility: {
			keyBindings: {
				previous: ['Shift+J'],
				next: ['Shift+K'],
				fitContent: ['Ctrl+Shift+F', 'Cmd+Shift+F'],
				refresh: ['Option+[KeyR]'],
				zoomOut: [],
			},
		},
	};
</script>

<div style="height: 420px" use:lumenChart={{ options }}></div>`,
			solid: `import { LumenChart, type ChartOptions, type DeepPartial } from '@lumen-charts/solid';

const options: DeepPartial<ChartOptions> = {
	accessibility: {
		keyBindings: {
			previous: ['Shift+J'],
			next: ['Shift+K'],
			fitContent: ['Ctrl+Shift+F', 'Cmd+Shift+F'],
			refresh: ['Option+[KeyR]'],
			zoomOut: [],
		},
	},
};

export function CustomShortcutsChart() {
	return <LumenChart class="chart-box" options={options} />;
}`,
		},
	],

	errors: [
		{
			blockIndex: 0,
			match: "chart.subscribe('error'",
			react: `import { LumenChart, type ChartApi } from '@lumen-charts/react';
import { useEffect, useState } from 'react';

export function ResilientChart() {
	const [chart, setChart] = useState<ChartApi | null>(null);
	const [workerFailed, setWorkerFailed] = useState(false);

	useEffect(() => {
		if (chart === null) return;
		return chart.subscribe('error', error => {
			switch (error.kind) {
				case 'refused':
					console.warn(\`\${error.count} updates of \${error.seriesId} refused\`);
					break;
				case 'engine':
					log(error.message, error.cause);
					break;
				case 'worker':
					setWorkerFailed(true); // the chart keeps what it shows, and takes no more data
					break;
			}
		});
	}, [chart]);

	return (
		<>
			{workerFailed && <div role="alert">Data worker stopped — reload the chart to resume live updates.</div>}
			<LumenChart ref={setChart} style={{ height: 420 }} />
		</>
	);
}`,
			vue: `<script setup lang="ts">
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';

const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const workerFailed = ref(false);
let unsubscribe: (() => void) | undefined;

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	unsubscribe = chart.subscribe('error', error => {
		switch (error.kind) {
			case 'refused':
				console.warn(\`\${error.count} updates of \${error.seriesId} refused\`);
				break;
			case 'engine':
				log(error.message, error.cause);
				break;
			case 'worker':
				workerFailed.value = true;
				break;
		}
	});
});

onBeforeUnmount(() => unsubscribe?.());
</script>

<template>
	<div v-if="workerFailed" role="alert">Data worker stopped — reload the chart to resume live updates.</div>
	<LumenChart ref="chartEl" style="height: 420px" />
</template>`,
			svelte: `<script lang="ts">
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';
	import { onDestroy } from 'svelte';

	let workerFailed = $state(false);
	let unsubscribe: (() => void) | undefined;

	function onReady(chart: ChartApi) {
		unsubscribe = chart.subscribe('error', error => {
			switch (error.kind) {
				case 'refused':
					console.warn(\`\${error.count} updates of \${error.seriesId} refused\`);
					break;
				case 'engine':
					log(error.message, error.cause);
					break;
				case 'worker':
					workerFailed = true;
					break;
			}
		});
	}

	onDestroy(() => unsubscribe?.());
</script>

{#if workerFailed}
	<div role="alert">Data worker stopped — reload the chart to resume live updates.</div>
{/if}
<div style="height: 420px" use:lumenChart={{ onReady }}></div>`,
			solid: `import { LumenChart, type ChartApi } from '@lumen-charts/solid';
import { createSignal, onCleanup, Show } from 'solid-js';

export function ResilientChart() {
	const [workerFailed, setWorkerFailed] = createSignal(false);

	const handleReady = (chart: ChartApi) => {
		const unsubscribe = chart.subscribe('error', error => {
			switch (error.kind) {
				case 'refused':
					console.warn(\`\${error.count} updates of \${error.seriesId} refused\`);
					break;
				case 'engine':
					log(error.message, error.cause);
					break;
				case 'worker':
					setWorkerFailed(true);
					break;
			}
		});
		onCleanup(unsubscribe);
	};

	return (
		<>
			<Show when={workerFailed()}>
				<div role="alert">Data worker stopped — reload the chart to resume live updates.</div>
			</Show>
			<LumenChart class="chart-box" onReady={handleReady} />
		</>
	);
}`,
		},
	],
};
