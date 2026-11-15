# Lumen Charts

High-performance financial charting engine for the web.

> Status: early scaffold. The packages build and are tested, but the chart currently only
> mounts a canvas and paints its background. The design is in [docs/design.md](docs/design.md).

## Packages

| Package                | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `@lumen-charts/core`   | Framework-free chart: canvas, sizing, frame scheduling      |
| `@lumen-charts/engine` | Data engine: columnar chunk store (compute kernels to come) |
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
