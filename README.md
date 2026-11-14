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
pnpm typecheck
pnpm lint         # pnpm format to apply fixes
pnpm build        # emit dist/ for every package
```

Versioning uses Changesets: run `pnpm changeset` in a pull request that changes a package.
All packages are released together under one version.

## Layout

```
packages/   libraries published to npm
examples/   runnable examples (not published)
docs/       design documents
```
