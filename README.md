# Lumen Charts

High-performance financial charting engine for the web.

> Status: stage 1 of the [design](docs/design.md). Candlestick and line series on an ordinal time
> scale, with the data engine in a worker, panning, zooming and live updates. Level of detail,
> indicators and drawings are later stages.

## Usage

```ts
import { createChart } from 'lumen-charts';

const chart = createChart(document.getElementById('chart')!);
const candles = chart.addSeries('candlestick');

// Times are UTC milliseconds. Columns are the fastest way to hand over a long history;
// an array of { time, open, high, low, close } objects works too.
candles.setData({ time, open, high, low, close });
chart.timeScale().fitContent();

// A tick updates the bar with the same time, or starts a new bar.
candles.update({ time: Date.now(), open: 101, high: 102, low: 100.5, close: 101.4 });
```

History lives in the data engine, which runs in a worker. The main thread keeps only the bars
around the visible range, so data is applied asynchronously: `await chart.whenIdle()` resolves once
everything handed over so far is on screen. If the page blocks workers, the engine runs on the main
thread in slices of a few milliseconds, behind the same interface. Pass `worker: false` to force
that, or `worker: () => new Worker(...)` when a bundler needs the worker created in application
code (the worker entry is `@lumen-charts/engine/worker`).

### Themes and display options

```ts
const chart = createChart(element, {
	theme: 'auto', // 'light' (default), 'dark', or follow the system setting
	grid: { vertLines: { visible: false }, horzLines: { style: 'dashed' } },
	crosshair: { mode: 'magnet' }, // or 'normal', 'hidden'
	priceScale: { position: 'left', scaleMargins: { top: 0.1, bottom: 0.2 } },
	watermark: { visible: true, text: 'BTCUSD · 1m' },
});

// Nested options merge: this changes one color and keeps everything else.
chart.applyOptions({ layout: { textColor: '#8a93a6' } });

const candles = chart.addSeries('candlestick', {
	upColor: 'rgba(0, 0, 0, 0)', // hollow up candles
	borderVisible: true,
	priceLineStyle: 'dotted',
});
const average = chart.addSeries('line', { color: '#f5b83d', lineType: 'step', lineStyle: 'dashed' });
```

A theme sets only colors. Colors you set yourself take precedence and survive a theme change, so
`applyOptions({ theme: 'dark' })` flips the chart while keeping, say, a custom grid color. The
presets are exported as `themes` for building your own. Every option and its default is documented
in `ChartOptions`, `CandlestickOptions` and `LineOptions`.

## Packages

| Package                | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `@lumen-charts/core`   | Framework-free chart: scales, series views, canvas renderer |
| `@lumen-charts/engine` | Data engine: chunked column store, worker host and client   |
| `@lumen-charts/react`  | `LumenChart` component                                      |
| `@lumen-charts/vue`    | `LumenChart` component                                      |
| `@lumen-charts/svelte` | `lumenChart` action                                         |
| `@lumen-charts/solid`  | `LumenChart` component (client-side)                        |
| `lumen-charts`         | Re-exports `@lumen-charts/core`                             |

Bindings stay thin: they create the chart on mount, forward option changes to
`applyOptions`, and destroy it on unmount. Data goes through the chart API, never through props.

## Development

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm dev          # vanilla example with live reload
pnpm test         # unit tests (run against sources, no build needed)
pnpm typecheck    # tsrs (Rust port of the TypeScript 7 checker)
pnpm lint         # Oxlint
pnpm format       # Oxfmt; pnpm format:check only reports
pnpm build        # emit dist/ for every package with tsc
```

Versioning uses Changesets: run `pnpm changeset` in a pull request that changes a package.
All packages are released together under one version.

## Benchmarks

`benchmarks/` is a browser harness that measures chart libraries through one adapter interface
(`benchmarks/src/adapter.ts`). It measures Lightweight Charts 5.3.0 with conflation on and off
(`lwc-conflation-on`, `lwc-conflation-off`) and lumen from the workspace sources with the data
engine in a worker or on the main thread (`lumen-worker`, `lumen-main`). The stage 0 baseline and
the definition of every metric are in [docs/benchmarks/stage-0-baseline.md](docs/benchmarks/stage-0-baseline.md);
stage 1 results against it are in [docs/benchmarks/stage-1.md](docs/benchmarks/stage-1.md).

```sh
pnpm bench:install                      # once: download Playwright's Chromium (CI never needs it)
pnpm bench --quick                      # smoke test, about a minute
pnpm bench                              # full matrix, headed Chromium, JSON in benchmarks/results/
pnpm bench --scenario tick --size 1m --lib lwc-conflation-off --repeats 3
pnpm bench --lib lumen-worker,lumen-main --repeats 3   # lumen only, about 8 minutes
pnpm bench --help                       # all options (headless, Chrome channel, viewport, DPR, ...)
pnpm bench:report <results.json>        # Markdown tables from a results file
pnpm bench:serve                        # production build of the harness page, to run by hand
```

## Layout

```
packages/     libraries published to npm
examples/     runnable examples (not published)
benchmarks/   benchmark harness (not published)
docs/         design documents and benchmark results
```
