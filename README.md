# Lumen Charts

High-performance financial charting engine for the web.

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

- [Several charts on one page](docs/guide/several-charts.md): shared workers, frames and observers.
- [Level of detail](docs/guide/level-of-detail.md): wide views draw from buckets, not bars.
- [History on demand: datafeed and memory limit](docs/guide/datafeed.md): bars let go and fetched again, corrections, deletions, resolution changes.
- [Indicators](docs/guide/indicators.md): the built-in ones, chains, and the histogram series.
- [Price axes](docs/guide/price-axes.md): several scales, logarithmic, percentage and indexed modes, tick sizes.
- [Custom indicators](docs/guide/custom-indicators.md): your own kernels, loaded into the engine as a module.
- [Drawings](docs/guide/drawings.md): tools, the pointer, events and their JSON.
- [Primitives and custom renderers](docs/guide/primitives.md): your own drawing code on the pane or instead of a series style.
- [Save and restore](docs/guide/save-restore.md): the chart's state as versioned JSON.
- [Themes and display options](docs/guide/themes.md): themes, grid, crosshair, watermark, series styles.
- [Time zones and sessions](docs/guide/time-zones.md): wall-clock axes, trading days, extended hours.

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

`benchmarks/` is a browser harness that measures chart libraries through one adapter interface.
How to run it, what it measures and the results of every stage are in
[docs/benchmarks/README.md](docs/benchmarks/README.md).

## Documentation

[docs/README.md](docs/README.md) lists the documents and says where a change to them goes: a
feature in a guide of its own, what a stage built and measured in files of their own.

### Adding a scenario

A scenario is one module in `benchmarks/src/scenarios/`. The harness finds the modules of that
directory itself (Vite's `import.meta.glob` for the page and the tests, a directory listing for the
runner and the reports in Node), so no list, union or `switch` elsewhere names a scenario. The
module exports what `defineScenario` (`benchmarks/src/scenario.ts`) returns, once per scenario of a
family:

- `name`: what `--scenario` selects and case ids begin with. `order`: its place in the matrix, the
  list of scenarios and the report; a new scenario takes a number above the others, and two with
  the same number go by name.
- `plan(context)`: its cases, from the options of the run (`quick`, the budgets, the size and kind
  filters). `caseParts(job)`: the parts of a case id after `<scenario>/<data set>`.
- `run(job, context)`: the measurement in the page, which returns the result. The steps scenarios
  share are in `benchmarks/src/harness/`.
- `headline(metric)`: the line the runner prints per case. `sections`: its tables in
  `pnpm bench:report`, built with the helpers of `benchmarks/src/report.ts`.
- `requires`, when it needs something only some libraries can do: the module declares that as an
  interface of its own and asks for it at run time with `supports`, so `ChartAdapter` stays what
  every library can do. An adapter that can implements the interface in its own file and lists the
  capability in its entry in `benchmarks/src/adapters/index.ts`; the others are skipped with the
  reason given.

The job and result types of a scenario are in its module too, and its tests go in
`benchmarks/test/scenarios/<name>.test.ts`. `benchmarks/test/scenarios/registry.test.ts` checks
every scenario found: a name of its own, all parts, cases under its name, and the same list in Node
as under Vite. A scenario module must not import `scenarios/index.ts` or a module that does
(`plan.ts`, `headline.ts`, `adapters/index.ts`).

## Layout

```
packages/     libraries published to npm
examples/     runnable examples (not published)
benchmarks/   benchmark harness (not published)
docs/         guides, the design and what each stage built, benchmark results
```

## License

[MIT](LICENSE). Each published package carries a copy of the license.
