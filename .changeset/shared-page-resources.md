---
'@lumen-charts/core': minor
'@lumen-charts/engine': minor
'lumen-charts': minor
'@lumen-charts/react': patch
'@lumen-charts/vue': patch
'@lumen-charts/svelte': patch
'@lumen-charts/solid': patch
---

Share browser resources between the charts of a page instead of creating them per chart.

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
  wrong under a CSS transform. Creating a chart or changing its options no longer forces a layout.
- Viewport: a chart scrolled out of view keeps applying data but is not drawn until it comes back.
  `whenIdle()` does not wait for that.
- Pointer input: hover, wheel and pinch read the chart's position at most once per frame. A wheel
  or pinch zoom is applied in the next frame, or earlier when the time scale is read or set.

`@lumen-charts/engine`: a worker host serves several engines, told apart by the `engine` id on
commands and events (`HostMessage`); `EngineClient` takes its place on a pooled worker.
