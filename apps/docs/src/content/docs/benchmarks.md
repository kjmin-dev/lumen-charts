---
title: Benchmarks
description: Browser benchmark harness methodology and measured results across millions of bars, 20 indicators, 1,000 drawings, and GPU mark series.
---

Lumen Ticks ships a Playwright browser benchmark harness in [`benchmarks/`](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/benchmarks/README.md) that measures chart libraries through one adapter interface (`lumen-worker`, `lumen-main`, and Lightweight Charts 5.3.0 with conflation on/off).

Every major stage was gated against explicit latency and frame-time budgets. All figures below come from committed benchmark reports recorded in [`docs/benchmarks/`](https://github.com/kjmin-dev/lumen-ticks/tree/main/docs/benchmarks) on an Apple M1 (headless Chromium, GPU rasterization, 1280 × 720 viewport at DPR 2, 1200 × 600 chart).

## 10M line points — pan, zoom & prepends (Stage 2)

Source: [`docs/benchmarks/stage-2.md`](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/benchmarks/stage-2.md)

| Metric (10M line points)                   | Target | `lumen-worker`        | `lumen-main`          |
| ------------------------------------------ | ------ | --------------------- | --------------------- |
| Pan frame JS p95 (worst of 6 zoom levels)  | 16 ms  | 1.06 ms (20k in view) | 1.09 ms (20k in view) |
| Zoom frame JS p95 (worst of 6 zoom levels) | 16 ms  | 1.22 ms (20k in view) | 1.17 ms (20k in view) |
| All 10M points in view — pan frame JS p95  | 16 ms  | 0.785 ms              | 0.790 ms              |
| All 10M points in view — zoom frame JS p95 | 16 ms  | 0.890 ms              | 0.865 ms              |
| Prepend 10k bars — shown p95               | 100 ms | 18.0 ms               | 18.0 ms               |
| Prepend 1M bars — shown p95                | 100 ms | 31.4 ms               | 22.3 ms               |

Because level-of-detail pyramids start at 16 bars per device pixel, frame time stops growing with the number of bars in view: zooming out from 20,000 to all 10,000,000 points actually drops frame JS time from ~1.1 ms to ~0.8 ms.

## 20 indicators on 1M candles (Stage 3)

Source: [`docs/benchmarks/stage-3.md`](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/benchmarks/stage-3.md)

Running 20 simultaneous indicators (25 output series: SMA, EMA, WMA, RSI, MACD, Bollinger, ATR, Stochastic, VWAP, Highest/Lowest, plus chained indicators) on 1,000,000 candlesticks:

| Metric                                              | Target | `lumen-worker` | `lumen-main`   |
| --------------------------------------------------- | ------ | -------------- | -------------- |
| Tick to applied patch p99 (latest 200 bars in view) | 4 ms   | 3.03–3.22 ms   | 0.285–0.295 ms |
| Recompute & show after 10k prepend (p95)            | 1 s    | 54.0 ms        | 36.2 ms        |
| Recompute & show after 1M prepend (p95)             | 1 s    | 542 ms         | 651 ms         |

Subsequent optimizations — starting worker background work immediately after commands, reusing merged pixel columns across whole-pixel pans (12–21% less frame JS with 20 indicators), and partial tick column redraws (~0.5 ms vs ~4 ms full redraw) — further tightened steady-state tick and pan costs.

## Drawings, save/restore & time zones (Stage 4)

- **1,000 drawings on 1M candles**: hover hit testing takes ~0.3 ms of JavaScript; opt-in drawing autoscale adds ~2 µs per range-computing frame ([`stage-4-drawings.md`](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/benchmarks/stage-4-drawings.md), [`stage-4-follow-ups.md`](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/benchmarks/stage-4-follow-ups.md)).
- **Save & restore (1,000 drawings + 5 indicators on 1M candles)**: `saveState()` takes ~0.07 ms; `restoreState()` into an empty chart takes ~3 ms including its frame ([`stage-4-save-restore.md`](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/benchmarks/stage-4-save-restore.md)).
- **Time zones**: converting timestamps uses precomputed zone offset tables with zero `Intl` calls per frame; first switch to a zone takes ~1 ms for two years of bars ([`stage-4-time-zones.md`](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/benchmarks/stage-4-time-zones.md)).

## Running the harness locally

```sh
pnpm bench:install                              # download Playwright Chromium once
pnpm bench --quick                              # ~1 minute smoke run
pnpm bench --scenario tick --size 1m --repeats 3
pnpm bench:pixels                               # pixel-for-pixel partial vs full redraw check
pnpm bench:report benchmarks/results/<run>.json # generate Markdown tables
```

See the full index of benchmark reports and raw JSON runs in [`docs/benchmarks/README.md`](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/benchmarks/README.md).
