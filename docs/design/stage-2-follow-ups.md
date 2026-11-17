# Stage 2 follow-ups: the datafeed contract, as built

What the stage 2 follow-ups built of the [design](../design.md). Each heading below is the section of the
design the text under it belongs to, and section numbers in the text are those of the design.
The measurements are in [docs/benchmarks/stage-2-follow-ups.md](../benchmarks/stage-2-follow-ups.md).

## 4.1 Chunked column store

- As built in the stage 2 follow-ups: the cap applies to every series with a Datafeed; a series without one is never dropped. A dropped chunk keeps a summary instead of its time column: first and last time, a 64-bit checksum of the times, a checksum of the values and, for a secondary series, the time of every 16th bar (the time pyramid has them for the main series). The main series keeps its time column while other series have data, because merging their bars into main bars needs every main time; a secondary series that gets data meanwhile waits until the main times are back.
  - Lookups across dropped chunks: chunk boundary times place a time before, inside or after a chunk; only a time strictly inside a chunk without its times has no exact row. A correction there waits for the chunk (a time between two chunks matches no bar and is refused at once); the bound of a secondary bar's slot at a chunk start is that chunk's first time; the rows a raw window needs from secondary series are found by the times of its first and last main bar.
  - A refetch is checked by the row count, the first and last time, the checksum, and the time of every 16th bar. Answers for chunks a waiting deletion removes bars from may lack those bars (the source has usually removed them already); the other bars are then checked by the times kept rather than the checksum, which also tells how many bars each gap held.
  - Anything that needs dropped rows waits for them and fetches them: a raw window until the rows of every series it shows are back, a correction until its bucket can be rebuilt from all members (holding up nothing else), and a deletion, or a new main timeline, until every row it reads or moves is back; later operations on that series wait behind it. Nothing is dropped while a command runs; the cap is enforced after each command and in background steps between commands, at most 32 chunks at a time, since a summary takes a pass over the chunk (dropping 10M points at once took over 100 ms).

## 4.2 LOD pyramid

- As built in the stage 2 follow-ups: a correction rebuilds its buckets from all members also when its bar was dropped (it waits until the bar is back), and so do bars that come back from the Datafeed with other values than the ones dropped. A deletion rebuilds the buckets at its edges, and those of the bars it moved.

## 8. External contract and scope

- As built in the stage 2 follow-ups:
  - Pull: `getBars({ from, to, countBack, signal })` resolves to the bars of a time range. The `signal` is aborted when the request becomes obsolete: the view moved away before the bars came (the engine cancels requests nothing needs), a new history (`setData`, also at another resolution), the series removed or the chart destroyed. Answers after an abort are ignored. Requests for the same bars are never out twice; a failed or refused request is retried after a pause that doubles from 1 s to 30 s, for those bars only.
  - Corrections: `update` corrects any existing bar, also a dropped one; the correction waits until its bars are back and the levels are rebuilt from all members. Bars that come back with other values than the ones dropped are taken over as corrections at the source. TradingView handles history changes with `onResetCacheNeededCallback` (reload everything); here only the bars concerned are fetched.
  - Deletions: `removeBars({ from, to })`. Bars at either end are cut off and the others keep their indexes. In the middle, the bars on one side move over to close the gap: the side with fewer dropped bars, then the shorter one. For the main series that re-bases those indexes and starts a new epoch, as a new history does. A tombstone (the bar kept with no values) would keep indexes without moving anything, but the bar would still take a slot on the ordinal time scale, keep its time for secondary bars to merge into, and no longer match a Datafeed that has removed it; re-basing costs a copy of the shorter side and new windows, once per deletion, and leaves no trace.
  - Resolution changes: `setData(bars, { datafeed })` replaces the history and the Datafeed. It drops the series' requests (aborting them), its waiting operations, its windows (new epoch for the main series) and its levels.
