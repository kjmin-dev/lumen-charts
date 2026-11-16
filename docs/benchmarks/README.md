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
pnpm bench:report <results.json>        # Markdown tables from a results file
pnpm bench:merge <out.json> <a.json> <b.json>   # join runs of the same cases into one file
pnpm bench:pixels                       # partial redraws against full redraws, pixel for pixel (--dpr, --raster, --case)
pnpm bench:serve                        # production build of the harness page, to run by hand
```

## Metrics

The definition of every metric is in [stage-0-baseline.md](stage-0-baseline.md), with the stage 0 baseline.

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
- [stage-4-save-restore.md](stage-4-save-restore.md): the `state` scenario saves and restores a chart with 5 indicators and 1,000 drawings.
- [stage-5-profile.md](stage-5-profile.md): where frame, tick and load time goes, from traces of these scenarios, and what that decides about the optional steps of stage 5.
- [stage-5-min-max.md](stage-5-min-max.md): the first of them, the min/max loops, is measured before and after.
- [stage-5-partial-redraw.md](stage-5-partial-redraw.md): the second, the partial redraw of tick frames; `pnpm bench:pixels` checks in headless Chromium that such a frame leaves the pixels of a full redraw.
