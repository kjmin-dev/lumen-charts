# Benchmarks

`benchmarks/` is a browser harness that measures chart libraries through one adapter interface
(`benchmarks/src/adapter.ts`). It measures Lightweight Charts 5.3.0 with conflation on and off
(`lwc-conflation-on`, `lwc-conflation-off`) and lumen from the workspace sources with the data
engine in a worker or on the main thread (`lumen-worker`, `lumen-main`).

## Running

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
pnpm bench --case ind-frames/candles-1m/pan-all --profile benchmarks/results/traces   # trace the runs: CPU by category, frames, GC
pnpm bench:profile benchmarks/results/traces    # the breakdowns again from the traces of a directory
pnpm bench --case ind-apply,tick --allocations benchmarks/results/allocations   # what the main thread allocates per tick, by call site, and its collections
pnpm bench:report <results.json>        # Markdown tables from a results file
pnpm bench:merge <out.json> <a.json> <b.json>   # join runs of the same cases into one file
pnpm bench:pixels                       # partial redraws against full redraws, pixel for pixel (--dpr, --raster, --redraw, --case)
pnpm bench:serve                        # production build of the harness page, to run by hand
pnpm bench --browser firefox --case frames/candles-1m --lib lumen-worker   # headless Firefox: no DevTools protocol, so no memory, traces or forced GC
pnpm bench --android <serial> --case frames/candles-1m --lib lumen-worker # Chrome on a USB-connected Android device, at its own viewport and ratio
node benchmarks/runner/mark-charts.mjs --android <serial> --tolerance 2   # image comparisons on the device
```

## Metrics

The definition of every metric is in [stage-0-baseline.md](stage-0-baseline.md), with the stage 0 baseline.

## Adding a scenario

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

## Results

One line per document, in the order they were written. A new document adds one line at the end.
The JSON files beside each document are the runs its numbers come from.

- [stage-0-baseline.md](stage-0-baseline.md): the stage 0 baseline and the definition of every metric.
- [stage-1.md](stage-1.md): stage 1 results against it.
- [stage-2-before.md](stage-2-before.md): the stage 2 scenarios with the stage 1 numbers on them.
- [stage-2.md](stage-2.md): stage 2 (level of detail, memory limit) against them.
- [stage-2-follow-ups.md](stage-2-follow-ups.md): the `refetch` scenario runs series with a datafeed under a memory limit, times how long the chart takes to show history it let go and what corrections, deletions and a change of resolution cost, and measures the memory floor.
- [shared-resources.md](shared-resources.md): the `multi` scenario puts several auto-sized charts on one page, some of them below the fold, and measures workers, memory, the time until all are shown and the cost of a round of ticks.
- [stage-3.md](stage-3.md): the stage 3 scenarios (`ind-load`, `ind-apply`, `ind-frames`, `ind-prepend`) put 20 indicators on the candles.
- [stage-4-price-axes.md](stage-4-price-axes.md): the `axes-frames` scenario pans and zooms candles with three moving averages on one axis, on a logarithmic or a percentage scale, and on four axes; it and the frame cases of earlier stages against `main`.
- [stage-4-drawings.md](stage-4-drawings.md): the `drawings` scenario hovers, drags and pans over 1,000 drawings on 1M candles (the stage 4 hover gate).
- [stage-4-time-zones.md](stage-4-time-zones.md): the scenarios `tz-frames` (pan and zoom in New York time with the sessions of an equity exchange) and `tz-change` (switching time zones at run time).
- [stage-4-follow-ups.md](stage-4-follow-ups.md): the `draw-autoscale` scenario pans with 100 and 1,000 drawings that take part in autoscale; hover over 1,000 drawings and a restore of 1,000, matched by id, against `main`.
- [stage-4-save-restore.md](stage-4-save-restore.md): the `state` scenario saves and restores a chart with 5 indicators and 1,000 drawings.
- [stage-5-profile.md](stage-5-profile.md): where frame, tick and load time goes, from traces of these scenarios, and what that decides about the optional steps of stage 5.
- [GC and tick latency](gc-floor.md) attributes the main-thread allocations per tick and checks the stage 3 gate.
- [stage-5-min-max.md](stage-5-min-max.md): the first of them, the min/max loops, is measured before and after.
- [stage-5-partial-redraw.md](stage-5-partial-redraw.md): the second, the partial redraw of tick frames; `pnpm bench:pixels` checks in headless Chromium that such a frame leaves the pixels of a full redraw.
- [stage-5-partial-redraw-options.md](stage-5-partial-redraw-options.md): the option that turns partial frames off (`redraw: 'full'`, checked by `pnpm bench:pixels --redraw full` on both rasterizers) and dashed lines drawn from the changed columns; the `line-ticks` scenario draws a frame per tick on solid, dashed and dotted lines.
- [stage-5-heatmap-scatter.md](stage-5-heatmap-scatter.md): the scenarios `scatter` and `heatmap` pan, zoom and update the two series drawn through a pixel buffer, up to the number of marks at which a frame misses its budget.
- [Mark rendering backends](mark-backends.md) compares Canvas 2D, WebGL2 and WebGPU on the same scatter and heatmap fixtures, including GPU pass timings and compositor cadence.
- [Sparse scatter and small updates](mark-fast-paths.md) measures tile indexing, cached pans, direct patch transfers and deferred uploads.
- [Heatmap color range](heat-range.md) measures fixed and changing color limits and direct WebGPU presentation.
- [Scatter rendering paths](scatter-paths.md) compares the instanced-quad WebGPU renderer with a compute shader and WebGL2 native points across densities.

- [Integrated mark renderers](integrated-mark-renderers.md) compares complete charts with real engine windows and documents browser coverage.

- [Per-chart mark renderers](explicit-mark-renderers.md) records WebGL2 integration timings and the cross-browser fallback and image comparisons.
- [Live mark composition](mark-update-composition.md) measures heatmap update frames, texture uploads and shared drawing-buffer capacity.
- [background-start.md](background-start.md): a worker starts background work right after a command instead of 20 ms later; prepends and loads with indicators settle sooner.
- [merged-pan.md](merged-pan.md): a pan keeps the merged pixel columns of every series instead of merging them again; pan frames with 20 indicators take 12–21% less JavaScript.
- [held-level-patches.md](held-level-patches.md): ticks send patches of the levels the chart's window cache holds only; `ind-apply` on 1M candles and `multi` before and after (measurements pending).
- [WebGL2 heatmap](webgl2-heatmap.md) measures shift-and-mask word lookups and palette-slot heatmaps for a fixed value range, with WebGL2 GPU timer queries.
- [WebGPU workload specialization](webgpu-workload-specialization.md) prototypes a single-pass column kernel for large scatter squares, packed palette slots for heatmaps and projection of only the visible scatter rows, against the shipping WebGPU paths.
- [WebGPU specialized paths](webgpu-specialized-paths.md) measures the integrated large-square kernel, visible-row scatter projection and heatmap palette slots against `main`, with the 1M cloud A/B of the projection change.
- [mark-history.md](mark-history.md): what prepending, removing, letting go and fetching back marks, and indicators over them, cost in the engine, and byte-for-byte checks of heatmaps whose grid follows the price in three browsers.
- [scatter-size-density.md](scatter-size-density.md): frame time of scatters with a size per point and with density coloring on Canvas 2D, WebGL2 and WebGPU, and their whole-chart image comparisons.
- [Physical Android device](android-physical.md) runs the harness and the image comparisons in Chrome on a USB-connected phone, and records a flagship phone against the mark budgets and the stage gates.
- [Projection threshold](projection-threshold.md) calibrates when a WebGPU scatter draw that starts over projects every held row.
- [Firefox on the M1](firefox-frames.md) runs the gate and mark cases in headless Firefox against Chromium.
- [Automatic renderer selection](mark-renderer-auto.md) compares the three backends on the M1 and the phone and keeps `auto` on WebGL2.
- [Review experiments](review-remeasure.md) measures the chunked store's scan cost again.
- [GPU mark renderer gaps](mark-gpu-device-gaps.md) takes the phone's open questions to the M1: the WebGL2 scatter append and 1M zoom, the cause of the one-step pixel differences (the browser's premultiplication of a straight-alpha drawing buffer), Chrome's extra WebGPU canvas copy, and the cost of the WebGPU compute pass.
