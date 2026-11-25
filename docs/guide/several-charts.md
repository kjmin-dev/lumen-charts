# Several charts on one page

```ts
import { configureWorker, createChart, createWorkerPool } from '@lumen-ticks/core';

// Optional: cap shared workers globally (same as `setMaxWorkers(2)`), or configure a bundler entry once.
configureWorker({ maxWorkers: 2 });
const charts = cells.map(cell => createChart(cell));

// Optional: isolate a heavy flagship chart on a dedicated worker, or create a scoped pool with pre-warming.
const watchlistPool = createWorkerPool({ maxWorkers: 2 });
watchlistPool.warmup(1);
const mainChart = createChart(mainCell, { worker: 'dedicated' });
```

Charts share what the browser gives them instead of each taking its own:

- **Workers.** The first charts get a worker each, up to a limit: 4, or one less than the number of
  processor cores where that is smaller. Every further chart joins the worker with the fewest
  charts. Each chart keeps a data engine of its own inside its worker, the charts of a worker take
  turns in slices of a few milliseconds, and a worker stops when its last chart is destroyed.
  `configureWorker({ maxWorkers: n })` (or `setMaxWorkers(n)`) changes the limit for charts created
  afterwards (`1` puts every chart on one thread, `Infinity` gives every chart its own);
  `getMaxWorkers()` and `getWorkerConfig()` read it. Charts given the same worker URL, bundler
  constructor (`?worker`), or factory share the workers it makes automatically. Pass
  `worker: 'dedicated'` to isolate one chart on a thread of its own, or `createWorkerPool(...)` to
  manage a separate bounded pool with optional `warmup()` pre-starting and `destroy()` cleanup.
- **Frames.** One animation frame draws every chart that changed. All charts read from the layout
  before any of them writes to the DOM, and an error in one chart does not stop the others.
- **Size.** One `ResizeObserver` sizes the auto-sized charts. A chart fills the content box of its
  container, so padding and borders on the container are fine. Creating a chart or changing its
  options does not read the layout: the size is read once, in the first frame or when it is first
  needed.
- **Viewport.** A chart scrolled out of view keeps applying data but is not drawn until it comes
  back into view. `whenIdle()` does not wait for that.

The numbers are in [docs/benchmarks/shared-resources.md](../benchmarks/shared-resources.md).
