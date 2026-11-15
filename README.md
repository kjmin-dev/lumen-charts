# Lumen Charts

High-performance financial charting engine for the web.

> Status: stage 2 of the [design](docs/design.md). Candlestick and line series on an ordinal time
> scale, with the data engine in a worker, panning, zooming, live updates, level of detail and a
> memory limit backed by a datafeed. Indicators and drawings are later stages.

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

### Several charts on one page

```ts
import { createChart, setMaxWorkers } from 'lumen-charts';

setMaxWorkers(2); // optional, before the charts are created
const charts = cells.map(cell => createChart(cell));
```

Charts share what the browser gives them instead of each taking its own:

- **Workers.** The first charts get a worker each, up to a limit: 4, or one less than the number of
  processor cores where that is smaller. Every further chart joins the worker with the fewest
  charts. Each chart keeps a data engine of its own inside its worker, the charts of a worker take
  turns in slices of a few milliseconds, and a worker stops when its last chart is destroyed.
  `setMaxWorkers(n)` changes the limit for charts created afterwards (`1` puts every chart on one
  thread, `Infinity` gives every chart its own); `getMaxWorkers()` reads it. Charts given the same
  `worker` function share the workers it makes, and it is called once per worker: define the
  function once and pass it to every chart. A chart given a function of its own keeps a worker of
  its own.
- **Frames.** One animation frame draws every chart that changed. All charts read from the layout
  before any of them writes to the DOM, and an error in one chart does not stop the others.
- **Size.** One `ResizeObserver` sizes the auto-sized charts. A chart fills the content box of its
  container, so padding and borders on the container are fine. Creating a chart or changing its
  options does not force a layout.
- **Viewport.** A chart scrolled out of view keeps applying data but is not drawn until it comes
  back into view. `whenIdle()` does not wait for that.

The numbers are in [docs/benchmarks/shared-resources.md](docs/benchmarks/shared-resources.md).

Wide views draw from levels of detail: the engine keeps buckets of 16, 64, 256, ... bars (first
open, highest high, lowest low, last close; the largest volume), and above 16 bars per device pixel
the chart draws the coarsest level whose buckets fit a pixel column. Frame time stops growing with
the number of bars in view, and the main thread holds buckets instead of bars for wide views.

### History on demand: datafeed and memory limit

```ts
const chart = createChart(element, { memoryLimit: 64 * 1024 * 1024 });
const candles = chart.addSeries('candlestick', {
	datafeed: {
		// Bars with times in [from, to] (UTC ms, inclusive): `countBack` of them, oldest first, in
		// any format setData accepts.
		getBars: ({ from, to, countBack }) => fetchBars(symbol, from, to),
	},
});
candles.setData(history);
```

With a datafeed, the engine may let go of bars far from the view once it holds more than
`memoryLimit` bytes, and asks the datafeed for them when the view comes back. The levels of detail
and the time of every bar stay in memory, so zoomed-out views keep drawing, the finest level is
shown while bars are on their way, and the bars that come back are checked against the ones let go:
bars that differ in number or time are refused with a console warning. A failed request is tried
again the next time the bars are needed, after a pause that grows from 1 s to 30 s. The same bars are
never requested twice at once. Without a datafeed nothing is ever let go.

The limit is a target: the bars around the view, the first and last chunk of 8,192 bars, the levels
and the time column always stay. For now it applies only while the series with the datafeed is the
only series with data; other series, corrections and deletions through the datafeed, resolution
changes and cancelling requests are follow-ups (design section 8).

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
All packages are released together under one version. Releases go to npm from CI with trusted
publishing and provenance after a maintainer approves them; [docs/releasing.md](docs/releasing.md)
describes the flow and the one-time setup.

## Benchmarks

`benchmarks/` is a browser harness that measures chart libraries through one adapter interface
(`benchmarks/src/adapter.ts`). It measures Lightweight Charts 5.3.0 with conflation on and off
(`lwc-conflation-on`, `lwc-conflation-off`) and lumen from the workspace sources with the data
engine in a worker or on the main thread (`lumen-worker`, `lumen-main`). The stage 0 baseline and
the definition of every metric are in [docs/benchmarks/stage-0-baseline.md](docs/benchmarks/stage-0-baseline.md);
stage 1 results against it are in [docs/benchmarks/stage-1.md](docs/benchmarks/stage-1.md), the
stage 2 scenarios with the stage 1 numbers on them in [docs/benchmarks/stage-2-before.md](docs/benchmarks/stage-2-before.md),
and stage 2 (level of detail, memory limit) against them in [docs/benchmarks/stage-2.md](docs/benchmarks/stage-2.md).
The `refetch` scenario runs a series with a datafeed under a memory limit and times how long the
chart takes to show history it let go. The `multi` scenario puts several auto-sized charts on one
page, some of them below the fold, and measures workers, memory, the time until all are shown and
the cost of a round of ticks; its results are in
[docs/benchmarks/shared-resources.md](docs/benchmarks/shared-resources.md).

Runs are headless by default (Chromium's new headless mode, rasterizing on the GPU), so no window
takes the focus; `--headed` opens a window. Stage 0 and stage 1 were measured headed. Frame
JavaScript time and tick cost, the metrics of the gates, match between the two modes, but headless
frame intervals stay at the refresh interval (p95 16.67 ms) and do not show rasterization or
presentation stalls: compare intervals only between headed runs.

```sh
pnpm bench:install                      # once: download Playwright's Chromium (CI never needs it)
pnpm bench --quick                      # smoke test, about a minute
pnpm bench                              # full matrix, headless Chromium, JSON in benchmarks/results/
pnpm bench --scenario tick --size 1m --lib lwc-conflation-off --repeats 3
pnpm bench --case frames/line-10m,prepend --lib lumen-worker,lumen-main --repeats 3
pnpm bench --scenario multi --lib lumen-worker --max-workers 1,4,default
pnpm bench --packages ../other-checkout/packages --lib lumen-worker   # measure another checkout
pnpm bench --help                       # all options (headed, Chrome channel, viewport, DPR, ...)
pnpm bench:report <results.json>        # Markdown tables from a results file
pnpm bench:merge <out.json> <a.json> <b.json>   # join runs of the same cases into one file
pnpm bench:serve                        # production build of the harness page, to run by hand
```

## Layout

```
packages/     libraries published to npm
examples/     runnable examples (not published)
benchmarks/   benchmark harness (not published)
docs/         design documents and benchmark results
```

## License

[MIT](LICENSE). Each published package carries a copy of the license.
