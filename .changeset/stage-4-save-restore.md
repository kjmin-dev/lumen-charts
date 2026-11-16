---
'@lumen-charts/core': minor
---

Add save and restore of a chart's state. `chart.saveState()` returns plain JSON with a `version`
(`CHART_STATE_VERSION`): the options applied, the series and indicators with their ids and options,
the drawings, and the view as the times at the edges of the pane and the ranges of price scales
that do not autoscale. `chart.restoreState(state)` checks all of it first and throws, leaving the
chart as it was, for another version or a state that is wrong anywhere; then it applies it in one
frame. Series the chart already has are matched by `id` and keep their bars, datafeed, renderer and
primitives; indicators are kept where they are the same and computed again otherwise; the view
comes back to the same times whatever history is loaded. Bars, the size of the chart, `worker`,
`memoryLimit` and formatter functions are not saved; custom indicators are saved by name and must
be registered before a restore. Both calls take `{ parts }` to work on some of `options`, `series`,
`indicators`, `drawings` and `view`.

Series and indicators have an `id` (the `id` option when they are added, or `series-1`,
`indicator-1`, ... by default), and `chart.series()` and `chart.indicators()` list them.
`indicator.options()` includes the `id`.

`indicator.applyOptions` no longer computes the indicator again when the parameters it is given are
the ones it has.
