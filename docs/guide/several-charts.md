# Several charts on one page

```ts
import { createChart, setMaxWorkers } from 'lumen-charts';

setMaxWorkers(2); // optional, before the charts are created
const charts = cells.map(cell => createChart(cell));
```

Charts share what the browser gives them instead of each taking its own:

- **Workers.** The first charts get a worker each, up to a limit: 4, or one less than the number of
  processor cores where that is smaller. Every further chart joins the worker with the fewest
  charts. Each chart keeps a data engine of its own inside its worker, the charts of a worker take
  turns in slices of a few milliseconds, and a worker stops when its last chart is destroyed.
  `setMaxWorkers(n)` changes the limit for charts created afterwards (`1` puts every chart on one
  thread, `Infinity` gives every chart its own); `getMaxWorkers()` reads it. Charts given the same
  `worker` function share the workers it makes, and it is called once per worker: define the
  function once and pass it to every chart. A chart given a function of its own keeps a worker of
  its own.
- **Frames.** One animation frame draws every chart that changed. All charts read from the layout
  before any of them writes to the DOM, and an error in one chart does not stop the others.
- **Size.** One `ResizeObserver` sizes the auto-sized charts. A chart fills the content box of its
  container, so padding and borders on the container are fine. Creating a chart or changing its
  options does not read the layout: the size is read once, in the first frame or when it is first
  needed.
- **Viewport.** A chart scrolled out of view keeps applying data but is not drawn until it comes
  back into view. `whenIdle()` does not wait for that.

The numbers are in [docs/benchmarks/shared-resources.md](../benchmarks/shared-resources.md).
