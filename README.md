# Lumen Charts

High-performance financial charting engine for the web.

- **Documentation:** [lumen-charts.studiocyf.app](https://lumen-charts.studiocyf.app) (with interactive chart demos and [`llms.txt`](https://lumen-charts.studiocyf.app/llms.txt))

> Status: stage 4 of the [design](docs/design.md) is complete; of the optional steps of stage 5, [these](docs/design/stage-5.md) are decided or built.

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

## Features

Candlestick, line and histogram series on an ordinal time scale, with the data engine in a worker,
panning, zooming, live updates, level of detail, a memory limit backed by a datafeed that also takes
corrections, deletions and resolution changes, indicators (built-in and custom) computed in the
engine, several price axes with their scale modes, time zones and sessions, drawings and
primitives, and save and restore of the chart's state.

Each has a guide:

- [Keyboard navigation and screen readers](docs/guide/accessibility.md) covers the chart navigator and its data summaries.
- [Several charts on one page](docs/guide/several-charts.md): shared workers, frames and observers.
- [Level of detail](docs/guide/level-of-detail.md): wide views draw from buckets, not bars.
- [History on demand: datafeed and memory limit](docs/guide/datafeed.md): bars let go and fetched again, corrections, deletions, resolution changes.
- [Indicators](docs/guide/indicators.md): the built-in indicators, chains, histograms and independent indicator panes.
- [Price axes](docs/guide/price-axes.md): several scales, logarithmic, percentage and indexed modes, tick sizes.
- [Custom indicators](docs/guide/custom-indicators.md): your own kernels, loaded into the engine as a module.
- [Drawings](docs/guide/drawings.md): tools, the pointer, events and their JSON.
- [Primitives and custom renderers](docs/guide/primitives.md): your own drawing code on the pane or instead of a series style.
- [Save and restore](docs/guide/save-restore.md): the chart's state as versioned JSON.
- [Themes and display options](docs/guide/themes.md): themes, grid, crosshair, watermark, series styles.
- [Time zones and sessions](docs/guide/time-zones.md): wall-clock axes, trading days, extended hours.
- [Heatmap and scatter series](docs/guide/heatmap-scatter.md): order books and trades with per-chart WebGL2, WebGPU or Canvas 2D rendering.
- [Errors](docs/guide/errors.md): failed engine commands, a failed worker and refused updates, reported to `subscribe('error')`.
- [Events and coordinates](docs/guide/events.md): crosshair, click and visible range events, conversions, synced charts and history loaded on demand.

## Packages

| Package                | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `@lumen-charts/core`   | Framework-free chart: scales, series views, canvas renderer |
| `@lumen-charts/engine` | Data engine: column store, indicators, worker host, client  |
| `@lumen-charts/react`  | `LumenChart` component                                      |
| `@lumen-charts/vue`    | `LumenChart` component                                      |
| `@lumen-charts/svelte` | `lumenChart` action                                         |
| `@lumen-charts/solid`  | `LumenChart` component (client-side)                        |
| `lumen-charts`         | Re-exports `@lumen-charts/core`                             |

Bindings stay thin: they create the chart on mount, forward option changes to
`applyOptions`, and destroy it on unmount. Data goes through the chart API, never through props.
See [Framework bindings](https://lumen-charts.studiocyf.app/frameworks/) for React, Vue 3, Svelte 5,
and Solid examples (also available as synced tabs on every guide page).

## Development

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm dev          # vanilla example with live reload
pnpm docs:dev     # documentation site at http://localhost:4321
pnpm docs:build   # build the static documentation site into apps/docs/dist
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

`benchmarks/` is a browser harness that measures chart libraries through one adapter interface.
How to run it, what it measures and the results of every stage are in
[docs/benchmarks/README.md](docs/benchmarks/README.md).

## Documentation

[docs/README.md](docs/README.md) lists the documents and says where a change to them goes: a
feature in a guide of its own, what a stage built and measured in files of their own.

## Layout

```
apps/         documentation site (Astro Starlight, deployed to lumen-charts.studiocyf.app)
packages/     libraries published to npm
examples/     runnable examples (not published)
benchmarks/   benchmark harness (not published)
docs/         guides, the design and what each stage built, benchmark results
tools/        private release and deployment tooling
```

## License

[MIT](LICENSE). Each published package carries a copy of the license.
