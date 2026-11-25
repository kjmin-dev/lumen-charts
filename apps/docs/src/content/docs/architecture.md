---
title: Architecture
description: Core design principles, worker-backed columnar storage, level-of-detail pyramids, and shared page resources behind Lumen Ticks.
---

Lumen Ticks is built around four engineering principles established in [docs/design.md](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/design.md):

1. **Per-frame work is bounded by visible pixels; per-tick work is constant.**
2. **Algorithms (level of detail, incremental indicator state) come before low-level optimization.**
3. **Every optimization must pass a measured browser benchmark gate before landing.**
4. **Zero host-page requirements.** Workers, WebGPU, WebGL2, and `SharedArrayBuffer` are all optional and fall back cleanly.

## Process split

```text
Main thread                              Data engine (worker; time-sliced on main if blocked)
┌───────────────────────────────┐       ┌───────────────────────────────────┐
│ API & Datafeed adapter        │ bars, │ Chunked columnar store (owner)    │
│ Model: TimeScale, PriceScale  │ ticks │ LOD pyramid (16, 64, 256, ...)    │
│ Window cache: visible range   │──────▶│ Indicator engine (full &          │
│   ±2 screens & coarse LODs    │◀──────│   incremental, holds state)       │
│ View: f32 coordinate buffers  │ snap- │ Mark stores (heatmap & scatter)   │
│ Renderer: Canvas 2D + WebGL2/ │ shots,│ Custom indicator ES modules       │
│   WebGPU mark layers          │patches└───────────────────────────────────┘
│ Input, hit testing, drawings  │
└───────────────────────────────┘
```

- **Single owner**: only the data engine owns full bar history, mark history, and indicator state. The main thread keeps a sliding window around the viewport plus coarse LOD levels, swapping in raw bars asynchronously after fast scrolls.
- **Atomic tick patches**: a live tick goes to the engine, which responds with one patch carrying the updated tail bar, affected LOD buckets, and the updated tail value of every indicator together — bars and indicators never disagree by a frame.
- **Identical asynchronous interface**: whether running inside a Web Worker or time-sliced in short main-thread slices, calling code uses the exact same protocol.

## Chunked columnar store & LOD pyramid

- Bars are stored in fixed **8,192-row chunks** of `Float64Array` columns (`time`, `open`, `high`, `low`, `close`, `volume`) inside a deque, giving O(1) prepends and appends with stable signed global indexes.
- Under a `memoryLimit` with a [datafeed](/guides/datafeed/), distant chunks are evicted while retaining time summaries and checksums so refetched chunks are validated on return.
- Coarse **level-of-detail pyramids** group bars by powers of 4 starting at 16 (`16, 64, 256, ...`), preserving first open, highest high, lowest low, last close, and min/max extremes for line and indicator outputs.

## Layered rendering & GPU mark backends

- **Three Canvas 2D pane layers** (series, drawings, crosshair/overlay) plus dedicated axis canvases minimize redraw area. When a tick changes only the tail bar on a GPU-rasterized canvas, `redraw: 'auto'` repaints only the affected device-pixel columns.
- **Mark series** (`heatmap` and `scatter`) render through per-chart selectable backends: `webgl2` (default, shared GL context per document), `webgpu` (compute/instanced specialized paths with automatic WebGL2 and Canvas 2D fallback), or `canvas2d` pixel buffers.
- **Shared page resources**: multiple charts on one page share a bounded worker pool, a single two-phase `requestAnimationFrame` loop (all DOM reads before all writes), one `ResizeObserver`, one `IntersectionObserver` (pausing off-screen draws), and shared time-zone offset tables.

## Deep-dive design documents

The repository preserves the full design document and per-stage decision records:

- [High-performance chart engine design](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/design.md)
- [Stage 2: Level of detail & memory limit](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/design/stage-2.md)
- [Stage 3: Indicators & plugins](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/design/stage-3-indicators.md)
- [Stage 4: Price axes, drawings, time zones, save/restore](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/README.md#what-each-stage-built)
- [Stage 5: Heatmap, scatter & mark renderers](https://github.com/kjmin-dev/lumen-ticks/blob/main/docs/design/stage-5-heatmap-scatter.md)
