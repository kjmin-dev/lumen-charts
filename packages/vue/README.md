# @lumen-charts/vue

Vue 3 bindings for [Lumen Charts](https://github.com/kjmin-dev/lumen-charts), a high-performance financial charting engine for the web.

```sh
npm install @lumen-charts/vue vue
```

## Usage

`LumenChart` creates the chart on mount, deep-watches `options` to forward updates to `applyOptions`, and destroys the chart on unmount. Access `ChartApi` via `chart` on the template ref.

```vue
<script setup lang="ts">
import type { OhlcColumns } from '@lumen-charts/core';
import { LumenChart, type ChartApi } from '@lumen-charts/vue';
import { computed, onMounted, useTemplateRef } from 'vue';

const props = defineProps<{ dark: boolean; bars: OhlcColumns }>();
const chartEl = useTemplateRef<{ chart: ChartApi | null }>('chartEl');
const options = computed(() => ({ theme: props.dark ? ('dark' as const) : ('light' as const) }));

onMounted(() => {
	const chart = chartEl.value?.chart;
	if (!chart) return;
	const candles = chart.addSeries('candlestick', { id: 'BTCUSD' });
	candles.setData(props.bars);
	chart.timeScale().fitContent();
});
</script>

<template>
	<LumenChart ref="chartEl" :options="options" style="height: 420px" />
</template>
```

More examples (live ticks, events, indicators, drawings, and SSR) are in the [Framework bindings guide](https://lumen-charts.studiocyf.app/frameworks/) and the [main README](https://github.com/kjmin-dev/lumen-charts#readme).

## License

MIT
