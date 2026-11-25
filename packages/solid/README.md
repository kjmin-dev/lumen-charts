# @lumen-ticks/solid

Solid bindings for [Lumen Ticks](https://github.com/kjmin-dev/lumen-ticks), a high-performance financial charting engine for the web.

```sh
npm install @lumen-ticks/solid solid-js
```

## Usage

`LumenChart` renders a client-side `<div>`, forwards reactive `options` updates to `applyOptions`, and destroys the chart on cleanup. Style the container with `class` and receive `ChartApi` in `onReady`.

```tsx
import type { OhlcColumns } from '@lumen-ticks/core';
import { LumenChart, type ChartApi } from '@lumen-ticks/solid';

export function PriceChart(props: { dark: boolean; bars: OhlcColumns }) {
	const handleReady = (chart: ChartApi) => {
		const candles = chart.addSeries('candlestick', { id: 'BTCUSD' });
		candles.setData(props.bars);
		chart.timeScale().fitContent();
	};

	return <LumenChart class="chart-box" options={{ theme: props.dark ? 'dark' : 'light' }} onReady={handleReady} />;
}
```

More examples (live ticks, events, indicators, drawings, and SSR) are in the [Framework bindings guide](https://lumen-ticks.studiocyf.app/frameworks/) and the [main README](https://github.com/kjmin-dev/lumen-ticks#readme).

## License

MIT
