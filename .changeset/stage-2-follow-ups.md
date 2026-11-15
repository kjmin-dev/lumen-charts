---
'@lumen-charts/core': minor
'@lumen-charts/engine': minor
---

Complete the datafeed contract and the memory limit.

- `DatafeedRequest.signal`: an `AbortSignal` aborted when the bars are no longer needed (the view
  moved away before they came, a new history, the series removed, the chart destroyed).
- `SeriesApi.update` corrects any existing bar, also one the memory limit let go: the correction
  waits for its bars to be fetched again, and the levels of detail are rebuilt from all members.
  Bars that come back with other values than the ones let go are taken over as corrections.
- `SeriesApi.removeBars({ from, to })` removes bars: at either end the other bars keep their
  indexes; in the middle the bars on the shorter side move over (a new epoch for the main series).
- `SeriesApi.setData(data, { datafeed })` switches resolution or symbol with a new datafeed; requests
  for the old history are aborted and their answers ignored.
- The memory limit applies with several series: secondary series with a datafeed are let go too,
  series without one never, and a raw window waits for the rows of every series it shows.
- Chunks let go keep a summary instead of their time column (first and last time, checksums), which
  lowers the floor on 10M line points from about 109 MiB to the levels of detail.
- History fetched again is drawn in the frame after the view changed instead of the second one.
- Indicators follow changes of history: a correction recomputes them (in place when the bar is
  recent), a deletion recomputes them in the background, and a recomputation fetches the rows of
  every series it reads that were let go.

Engine protocol: fetch requests carry an `id`, `rows` hands rows back by it, events may carry
`cancel`, `waiting`, `applied` and `refused` (notices carry `fetch` and `cancel` for recomputations),
a `delete` command removes bars, `set` takes `fetchable`, and window snapshots carry the `request`
they answer.
