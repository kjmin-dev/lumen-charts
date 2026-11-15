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
(`benchmarks/src/adapter.ts`). It currently measures Lightweight Charts 5.3.0 with conflation on
and off; the stage 0 baseline and the definition of every metric are in
[docs/benchmarks/stage-0-baseline.md](docs/benchmarks/stage-0-baseline.md).

```sh
pnpm bench:install                      # once: download Playwright's Chromium (CI never needs it)
pnpm bench --quick                      # smoke test, about a minute
pnpm bench                              # full matrix, headed Chromium, JSON in benchmarks/results/
pnpm bench --scenario tick --size 1m --lib lwc-conflation-off --repeats 3
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
