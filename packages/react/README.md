# @lumen-ticks/react

React bindings for [Lumen Ticks](https://github.com/kjmin-dev/lumen-ticks), a high-performance financial charting engine for the web.

```sh
npm install @lumen-ticks/react react
```

## Usage

`LumenChart` creates the chart on mount, forwards reactive `options` updates to `applyOptions`, and destroys the chart on unmount. Data always goes through `ChartApi` (exposed via `ref`), never through props.

```tsx
import type { OhlcColumns } from '@lumen-ticks/core';
import { LumenChart, type ChartApi } from '@lumen-ticks/react';
import { useEffect, useMemo, useState } from 'react';

export function PriceChart({ dark, bars }: { dark: boolean; bars: OhlcColumns }) {
	const [chart, setChart] = useState<ChartApi | null>(null);
	const options = useMemo(() => ({ theme: dark ? ('dark' as const) : ('light' as const) }), [dark]);

	useEffect(() => {
		if (chart === null) return;
		const candles = chart.addSeries('candlestick', { id: 'BTCUSD' });
		candles.setData(bars);
		chart.timeScale().fitContent();
		return () => chart.removeSeries(candles);
	}, [chart, bars]);

	return <LumenChart ref={setChart} options={options} style={{ height: 420 }} />;
}
```

More examples (live ticks, events, indicators, drawings, and SSR) are in the [Framework bindings guide](https://lumen-ticks.studiocyf.app/frameworks/) and the [main README](https://github.com/kjmin-dev/lumen-ticks#readme).

## License

MIT
