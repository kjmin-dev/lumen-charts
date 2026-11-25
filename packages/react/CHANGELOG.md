# @lumen-charts/react

## 0.1.0

### Minor Changes

- 4903db6: Add light and dark themes (plus `auto`, which follows the system color scheme) and display options:
  grid line visibility and style, crosshair modes and line styles, price axis position, visibility,
  border and margins, time axis visibility and border, and a watermark. Series gain `visible`, a
  separate price line with its own color, width and style, candle outlines and optional wicks, and line
  style, step lines and a crosshair marker. Chart options are now nested (`layout`, `grid`,
  `crosshair`, `priceScale`, `timeScale`, `watermark`) and `applyOptions` merges them deeply; the
  bindings take `DeepPartial<ChartOptions>`.
- 3dd18c0: Refine the worker declaration and pooling interface with zero hot-path overhead:

  - **Polymorphic `WorkerSource` & `WorkerOption`**: `worker` now accepts URL strings, `URL` objects (normalized by absolute `href` so callers share a pool automatically), bundler worker constructors such as Vite `?worker` imports (invoked safely with `new` instead of silently falling back to the main thread), `'dedicated'` for an unshared worker per chart, explicit `WorkerPool` handles, and existing booleans or `() => Worker` factories.
  - **Global configuration (`configureWorker` / `getWorkerConfig`)**: configure the default worker source, `maxWorkers`, and `timeout` once at app startup instead of threading worker factories through every chart.
  - **Explicit `WorkerPool` (`createWorkerPool`)**: manage isolated bounded worker pools with `maxWorkers`, `activeWorkers`, `engines`, optional `warmup(count?)` pre-starting, and `destroy()` teardown.
  - **Standalone `./worker` across every package**: `lumen-charts`, `@lumen-charts/core`, and all four framework bindings (`react`, `vue`, `svelte`, `solid`) now export a zero-import bundled `./worker` entry (with explicit `"sideEffects": ["./dist/worker.js"]`) and re-export the worker helpers directly.
  - **Options handling**: `DeepPartial`, `mergeOptions`, and `optionsEqual` now preserve `URL`, constructor, and `WorkerPool` values intact instead of flattening non-plain objects.

### Patch Changes

- 596451b: License the packages under MIT. Each package declares the license and ships a copy of it.
- 1b0920e: The `LumenChart` ref now hands out the chart once it is created (it stayed `null`), and is set back to `null` on unmount. Options changed before the chart is created are no longer lost.
- 73d2dbe: Ship a README and the TypeScript sources with every package, so source maps and declaration maps
  resolve in editors and bundlers.
- 591934d: Share browser resources between the charts of a page instead of creating them per chart.

  - Workers: charts share data-engine workers. The first charts get a worker each, up to a limit
    (4, or one less than the number of processor cores if that is smaller); further charts join the
    worker with the fewest charts. `setMaxWorkers(count)` changes the limit and `getMaxWorkers()`
    reads it. Charts given the same `worker` function share the workers it makes; a chart given a
    function of its own keeps a worker of its own. Each chart still has a data engine of its own
    inside its worker, and a worker stops when its last chart is destroyed.
  - Frames: one animation frame draws every chart. All charts read from the layout before any chart
    writes to the DOM, and an error in one chart no longer stops the others from drawing.
  - Size: an auto-sized chart now fills the content box of its container. It used the container's
    bounding rectangle, which made the chart too large in a container with padding or a border and
    wrong under a CSS transform. Creating a chart or changing its options no longer reads the
    layout: the size is read once, in the first frame or when it is first needed.
  - Viewport: a chart scrolled out of view keeps applying data but is not drawn until it comes back.
    `whenIdle()` does not wait for that.
  - Pointer input: hover, wheel and pinch read the chart's position at most once per frame. A wheel
    or pinch zoom is applied in the next frame, or earlier when the time scale is read or set.

  `@lumen-charts/engine`: a worker host serves several engines, told apart by the `engine` id on
  commands and events (`HostMessage`); `EngineClient` takes its place on a pooled worker.

- Updated dependencies [9ed5a66]
- Updated dependencies [bf975a1]
- Updated dependencies [b86ac7a]
- Updated dependencies [fd9b94e]
- Updated dependencies [4f3d46f]
- Updated dependencies [93097db]
- Updated dependencies [ca86b18]
- Updated dependencies [69de92d]
- Updated dependencies [6c1a6d5]
- Updated dependencies [9ee1ef4]
- Updated dependencies [f4495e7]
- Updated dependencies [64a361c]
- Updated dependencies [6c1a6d5]
- Updated dependencies [1164222]
- Updated dependencies [596451b]
- Updated dependencies [6c1a6d5]
- Updated dependencies [baccf89]
- Updated dependencies [6c1a6d5]
- Updated dependencies [73d2dbe]
- Updated dependencies [591934d]
- Updated dependencies [dcf50f3]
- Updated dependencies [0ed57f4]
- Updated dependencies [f44dd44]
- Updated dependencies [f44dd44]
- Updated dependencies [0be4eb2]
- Updated dependencies [f9502fe]
- Updated dependencies [9674020]
- Updated dependencies [2107937]
- Updated dependencies [1bc481a]
- Updated dependencies [a3358c0]
- Updated dependencies [cea020e]
- Updated dependencies [99d02d3]
- Updated dependencies [5416630]
- Updated dependencies [4903db6]
- Updated dependencies [1ecafaf]
- Updated dependencies [aef336f]
- Updated dependencies [3dd18c0]
  - @lumen-charts/core@0.1.0
