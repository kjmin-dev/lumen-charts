---
'@lumen-charts/core': minor
'@lumen-charts/engine': minor
---

Heatmap and scatter series. `chart.addSeries('scatter')` takes points at any time and price, many
per bar, each colored by a value; `chart.addSeries('heatmap')` takes columns of cells on a grid of
prices, as an order book or a volume profile over time. Both keep their data in the data engine,
with levels of detail of their own, and are drawn through a pixel buffer, so a frame costs by the
pixels of the pane rather than by canvas calls: a million points or cells in view pan within the
frame budget. They take a palette, a fixed or automatic value range, opacity and a price scale, are
updated live (`update`, `append`), and are saved and restored with the chart's state.
`chart.markSeries()` lists them.

The engine's protocol gains the `marks` and `marksWindow` commands and `marks` on events
(`EngineClient.addMarks`, `changeMarks`, `requestMarks`, `onmarks`).
