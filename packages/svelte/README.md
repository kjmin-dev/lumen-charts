# @lumen-charts/svelte

Svelte bindings (an action) for [Lumen Charts](https://github.com/kjmin-dev/lumen-charts), a high-performance financial charting engine for the web.

```sh
npm install @lumen-charts/svelte svelte
```

## Usage

`lumenChart` is a Svelte action that mounts a chart onto an element, forwards reactive `options` updates to `applyOptions`, and destroys the chart on teardown. Receive `ChartApi` once in `onReady`.

```svelte
<script lang="ts">
	import type { OhlcColumns } from '@lumen-charts/core';
	import { lumenChart, type ChartApi } from '@lumen-charts/svelte';

	let { dark = false, bars }: { dark?: boolean; bars: OhlcColumns } = $props();

	function onReady(chart: ChartApi) {
		const candles = chart.addSeries('candlestick', { id: 'BTCUSD' });
		candles.setData(bars);
		chart.timeScale().fitContent();
	}
</script>

<div style="height: 420px" use:lumenChart={{ options: { theme: dark ? 'dark' : 'light' }, onReady }}></div>
```

More examples (live ticks, events, indicators, drawings, and SSR) are in the [Framework bindings guide](https://lumen-charts.studiocyf.app/frameworks/) and the [main README](https://github.com/kjmin-dev/lumen-charts#readme).

## License

MIT
