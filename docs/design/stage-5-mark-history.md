# Stage 5 follow-ups: history, memory, timelines and indicators for marks, as built

What was built to close the limits [stage 5, heatmap and scatter](stage-5-heatmap-scatter.md) left
open: no datafeed for marks, no `prepend`, no removal, no indicators over them, no chart whose
timeline comes from them, no grid that follows the price, no size per point, no density of points,
no readout of a scatter, and a GPU palette-slot path only for fixed value ranges. Each heading below is the section of the [design](../design.md) the text under it
belongs to, and section numbers in the text are those of the design. Where this file and the stage 5
file differ, this one says what the library does now. The measurements are in
[docs/benchmarks/mark-history.md](../benchmarks/mark-history.md) and, for sizes and densities,
[docs/benchmarks/scatter-size-density.md](../benchmarks/scatter-size-density.md).

## 3. Architecture

- **Rows are numbered like bars.** The rows of every level of a scatter or heatmap store are signed
  indexes that stay put when rows are prepended: a level holds rows `[first, first + total)`, and
  `MarksUpdate` carries `first` beside `total`. A prepend therefore keeps the rows the client holds
  valid and changes no generation. A removal does change the generation: the rows on the shorter side
  of a gap move over, as bars do (section 8).
- **Changes that patches do not carry.** An append is patched into the window the client was sent
  last, as before. A prepend, a removal, and marks fetched back for a stand-in answer are not: the
  engine sends a `notice` (a `MarksUpdate` without rows), and the client asks for its view again. With
  another generation it draws the rows it holds until the new ones are there, as after `setData`.
- **One stream of changes for the engine's own readers.** Every change of a marks series that takes
  effect, in the command that sent it or later after waiting for marks to come back, is listed for
  the engine (`MarksOutcome.appliedMarks`, never sent): the timeline the series makes (section 8)
  and the indicators that read it (section 5) follow it from there.

## 4. Data layer

### 4.4 Scatter store (as built after stage 5)

- **Sizes, counts and cell bounds.** A point may carry a size in CSS pixels (`size`, NaN for the
  series' `pointSize`). The store keeps sizes only once a point has one. A cell of a coarse level
  keeps, besides the largest value, the number of points it holds, the largest size among them, and
  the exact time and price bounds (`[tMin, tMax, pMin, pMax]`) of the points inside it. `MarksUpdate`
  sends `counts` (empty at level 0), `sizes` (empty without sizes), and `bounds` (four doubles per
  coarse cell, empty at level 0). When a coarse cell spans less than one device pixel in both time
  and price, it is drawn as a centered stamp (as wide as its widest point, counting every point);
  when coarse cells span a device pixel or more, each cell is drawn over the exact area its points
  cover, expanded by its stamp size (square or rounded disc), identically across Canvas 2D, WebGL2,
  and `pointAt` hit testing.
- **Prepend.** Points at or before the first time are put in front, in their own order. Each level
  takes them by building the cells of buckets strictly before the old first bucket; when the old
  first bucket is touched and resident in the level below, that bucket is rebuilt in canonical scan
  order so coarse chunks remain evictable and deterministically rebuildable (falling back to in-place
  merge and marking the bucket non-evictable only when the level below has evicted chunks there).
- **Correction and removal.** `correct` replaces existing points over `[from, to]` (or spanning
  `data`'s times when absent) in place, refusing all if no existing points fall in the range or if
  all input points are invalid; `delete` removes points in `[from, to]`. Both make held every evicted
  coarse chunk they read or splice before mutating level 0, then rebuild the buckets spanning the
  affected range bottom-up across every coarse level and refresh the last bucket's bin index. The
  coarse chunks at the edges of the changed buckets are made from the finest level held below them
  without the cells of those buckets, which stand in until they are made again right after, so they
  need neither the points inside the change nor their source there; a chunk that does not come out
  as it was let go changes nothing (the change reports it, see 4.7). Every coarse level moves its
  rows on the side the points move on (whose points are held for the move anyway), or, when the
  points do not move, on the side with fewer chunks let go. A splice that would read a row let go,
  or write a chunk let go in part, throws before anything changes: an invariant, which before turned
  rows let go into zeros without a word.
- **Bounds in chunks let go.** Where a bucket or a time falls in a chunk let go, a search only finds
  the chunk (`lowerBucket` its start): the rows a bucket spans are taken to include that whole chunk,
  and the side a removal moves is decided only where it is the same for every position the bounds
  allow; otherwise the chunks at its edges are fetched first. Chunk numbers are signed once points
  are prepended, and are halved as such.

### 4.5 Heatmap store (as built after stage 5)

- **A grid that follows the price.** A column has a grid row of its own for its first cell
  (`offsets`, relative to the first column's lower edge) and a number of cells. Columns as given all
  have `rows` cells; a column of a coarse level spans the rows its members span, each cell the
  largest of the members' cells on that row. Chunks hold whole columns, whose cells follow one
  another; a rewrite of the columns of a chunk moves its cells at most once. A series whose columns
  all start at row 0 sends no offsets, and every reader keeps its old fast path for it.
- **Prepend, correction and removal.** Columns are indexed like bars: level `k` merges columns
  `[b · 4^k, (b + 1) · 4^k)`, so a prepend rebuilds only the first bucket of each level. `correct`
  overwrites existing columns at their exact timestamps in place (refusing non-matching times or
  off-grid columns) and rebuilds only the touched buckets bottom-up. A removal at either end cuts; in
  the middle the columns of the shorter side move over and the buckets of the moved columns are made
  again. A bucket of a coarse chunk whose cells were let go is not made: the chunk is made again from
  the levels below when it is read. The others are made from the finest level below that holds their
  members (the largest cell of each row is the same from any level, as buckets nest), so a correction
  of one column needs at most the columns of its topmost bucket where the levels between went, not
  whole chunks of every level. A level is let go once the level below has 512 columns or fewer and
  is held in full, or can be made so from what is held; until then it stays, and is rebuilt like the
  others, so the topmost level is always held and a removal never fetches columns only to drop a
  level.

### 4.6 Window of a mark series (as built after stage 5)

- The window holds counts, sizes and coarse cell `bounds` for a scatter, and for a heatmap whose grid
  follows the price each column's first row, number of cells and where its cells start (`cellStart`,
  `cellOffset`, `cellLength`); cells of patched columns, which always run to the end of the window,
  are written after those of the columns before them.

### 4.7 Marks under the memory limit (new)

- **What goes.** With a datafeed (`datafeed: { getMarks }` when the series is added, or with
  `setData`), chunks of level 0 and then intermediate coarse levels (`1 .. top - 1`, finer levels
  before coarser, farthest from the view first) are let go once the engine holds more than
  `memoryLimit`, after every chunk of bars that could go: 65,536 points or coarse cells of a scatter
  (all of a chunk but its summary), or the cells of a heatmap chunk (about 256 KB), keeping column
  times, rows and lengths. The topmost coarse level always stays resident as a guaranteed stand-in,
  and so do the first and last chunk of each scatter level and the coarse chunks holding cells of its
  first or last bucket (where prepends and appends merge into cells), the chunks of the first and
  last eight columns of each heatmap level and, at level 0, the columns of the first and last bucket
  of its topmost level (where appends and prepends rebuild buckets, from level 0 where the levels
  between went), the chunks overlapping the last view and its margins, those being fetched or waited
  for, and those an indicator recomputation has yet to read. Nothing goes before the series has a
  coarse level to draw from.
- **Summaries.** A scatter chunk (raw or coarse) keeps its row count, its first and last time, how
  many rows share those times, and a 64-bit checksum (raw level 0); a chunk whose rows share one time
  (or one time bucket for a coarse scatter level) is kept. A heatmap chunk keeps a checksum of its
  cells at level 0.
- **Fetching back and materializing coarse levels.** Before reporting missing chunks for a coarse
  window, the engine tries `store.materialize(level, start, end)`: when finer levels underneath are
  still resident, evicted coarse chunks rebuild immediately with zero fetch and no `partial` answer.
  When level-0 chunks underneath were also let go, the view is answered from the finest resident
  stand-in level (`partial`) and the engine fetches those level-0 chunks (`marksFetch`).
  `getMarks({ from, to, signal })` returns the marks of those times as the source holds them; the
  engine checks the number and checksum of a chunk nothing waits for and refuses mismatches (history
  changes go through `correct`, `removeMarks` or `setData`). Once every deferred level-0 chunk is
  back, any deferred coarse view is materialized immediately before sending the `notice`, preventing
  thrashing under tight limits. A request the view left is cancelled (`marksCancel`), and a failure
  or refusal pauses the series' next request, 1 s doubling to 30 s, once per round of requests
  however many of them failed.
- **Waiting.** A removal or in-place correction that would read, move or rebuild from marks let go
  (including evicted coarse chunks and their level-0 dependencies) is queued while those chunks are
  fetched; later changes wait behind it, and `setData` drops them. It asks for the chunks at its
  edges, those whose rows move, and those the coarse chunks it rebuilds or moves are made from:
  never those inside it. The chunks it needs stay pinned until the waiting changes have run; a failed
  fetch is asked for again with the next view request. A scatter removal or correction cancels
  requests out for the series because row shifts invalidate chunk numbers; what still needs marks
  asks again.
- **The datafeed returns the changed history.** An application changes its source, then the chart:
  the marks a waiting change needs come back as they went or as the change leaves them, and maybe
  the changes behind it. For a chunk the first waiting change needs, the engine takes either. As they
  went: number and checksum, as for any chunk. As changed: inside the ranges of the changes the marks
  must be the changes' own (none for a removal, a correction's points or columns, the later change's
  where ranges meet), in order; outside them a scatter chunk takes the points returned (its share of
  those at its first and last time as when it went), a heatmap chunk the cells of columns at the
  times and on the rows of those it held. Marks a waiting append or prepend adds (after a removal
  took the end or the start up to them) are not the chunk's and are taken out first. The points a
  scatter chunk held inside the ranges are not known: as many stand-ins take their place inside the
  range of the first change, which removes or replaces them; a reading that leaves out a change
  behind them that reaches the chunk outside their ranges is not taken, since what the marks show
  there could not be told apart. Scatter removals and corrections of other times commute: where the
  first change that reaches a chunk is not the first waiting, it goes first, and the changes that
  reach the chunk merge, with the marks returned between them (inside the chunk's times), into one
  correction of their span. Marks taken as changed go into their chunk right before the change runs,
  and out again where the exact bounds they give ask for more chunks first, so nothing reads a
  stand-in; if the coarse chunks the change makes from them do not come out as they were let go,
  they were not those marks, and are refused.
- **Refused, three rounds running.** Marks a waiting change needs that fit neither reading are
  refused (with a console warning), and the client asks again with its view after its pause. After
  three rounds of requests with refusals (pauses of 1, 2 and 4 s) the change is dropped and reported
  as a `refused` error of its series, 1 for a removal and its marks for a correction, and the changes
  behind it run: a datafeed that answers with neither holds the series up for seconds, not for good.
- **What asks for marks.** The view (cancelled when the view leaves them), a waiting removal, and an
  indicator recomputation (kept until it is answered, whatever the view does). A prepend keeps chunk
  numbers; where the client holds the first bucket of a coarse level, which takes prepended marks in,
  it also changes the generation, so those rows are sent again.

## 5. Compute layer

### 5.2 Indicators over marks (new)

- A bar whose times reach into a chunk let go has no value (NaN) until the chunk is back; the
  recomputation asks for it and waits.
- An indicator input can name a marks series and a column (`MARK_COLUMNS`): for each bar of the main
  timeline, an aggregate of the marks with times from the bar's to the next bar's (the last bar's on
  to any time). A scatter has `count`, `sum`, `max`, `min`, `mean`, `open`, `high`, `low`, `close` and
  `vwap`; a heatmap has the `sum` and `center` (value-weighted price) of the bar's last column, or of
  the last column before the bar when it has none, and the `max` and `min` cell of its columns.
- The engine reads these columns like the columns of a series: two binary searches and a pass over
  the bar's marks per bar. Appended marks change the input rows from the bar of their first time; a
  new bar changes the bar before it too, which gave up the marks from the new bar's time on. Both are
  computed in place in the command's message, as ticks are. Any other change recomputes the readers
  in the background. A recomputation that would read marks let go asks for them and waits, as one
  over bars does.

## 6. Render layer

### 6.3 Heatmap and scatter series (as built after stage 5)

- **Sizes.** A point is stamped with its center on the device pixel its time and price round to: a
  square, or the pixels of a disc, of its own size or of `pointSize`, in whole device pixels from 1 to
  256 (a stamp is made once per size and kept). The widest point a window holds sets how far beyond
  the view the series asks for and draws rows, and how far the WebGL2 renderer pads the ranges from
  which each column of pixels finds its first point; points without sizes keep the loop and the
  two-word GPU records they had, and a size per point is a third word.
- **Densities** (`colorBy: 'density'`). The counts of the points that cover each device pixel (1 for a
  point, the points of a cell at a coarse level) are summed into a buffer of 32-bit floats the size of
  the pane, then colored. On a linear scale from 1 to the frame's largest, a density's palette entry is
  255 (d − 1) / (largest − 1) rounded half up, in whole numbers; otherwise it is found among 255
  thresholds, the smallest density of each entry, computed in 64-bit floats from the frame's mapping of
  values, through a table for densities below 4096. WebGL2 sums the counts by additive blending into a
  float texture and brings the largest to one texel by passes of 16 by 16 texels; the color pass
  computes the whole-number entry from that texel on the GPU, or, for the thresholds, the texel is read
  back first (a logarithmic scale, a fixed `valueMin`) and each pixel searches them. Sums of whole
  numbers below 2^24 are exact in 32-bit floats and the entries are exact both ways, so both renderers
  draw the same pixels. An append adds its points to the sums and colors their pixels; one that raises
  the largest colors the frame again. Without float blending WebGL2 leaves densities to Canvas 2D, and
  WebGPU, whose kernels overwrite one square size, hands both sizes and densities to WebGL2.
- **Coarse scatter cell area rendering.** When a coarse scatter level's time buckets or price bins
  span at least one device pixel (`scatterCellArea`), each cell is drawn over the exact device-pixel
  rectangle of its points' `[tMin, tMax] × [pMin, pMax]` bounds expanded by its stamp size (square or
  rounded-disc corners via Minkowski sum with `makeStamp`). Sub-pixel coarse frames keep the
  centered-stamp fast path (including WebGPU's `scatter-columns` kernel). Super-pixel coarse frames
  use a 5-word record format on WebGL2 (`[originX, originY, rgbaOrCount, boxW, (boxH << 10) | size]`)
  for both value and density modes and route from WebGPU to WebGL2 with `reason: 'unsupported-style'`.
  Coarse scatter autoscale uses `pMin`/`pMax` from `bounds`, and `pointAt` hit-tests the exact same
  cell area geometry.
- **What a pixel buffer cannot do** is blend marks with each other: overlapping points of a value
  series do not mix (a density series counts them instead), and edges are not antialiased.

- **A grid that follows the price.** The geometry counts grid rows from the lowest first row of the
  columns drawn. Canvas 2D reads each column's cells through its first row and length, leaving the
  rows it has none on transparent. The GPU renderers get a column table after the pixel ranges (where
  the cells start, the first row plus 2^30, the length) and a uniform for the row base; a series that
  does not follow the price passes no table, and the shaders keep the old addressing.
- **Palette slots for an automatic value range.** A new extreme changes the slot of every cell, so a
  heatmap with an automatic range is drawn from its values while the range changes. Once it has stayed
  the same for 30 draws, the slots of the columns in view are made, at most 262,144 cells a draw (about
  a millisecond on the M1), with a frame requested for the next slice, and the GPU draws from them until
  the range changes, when it goes back to the values in that frame. Both paths draw the same pixels,
  checked in three browsers (section 9).

## 7. Interaction

- **Hover**: `ScatterSeriesApi.pointAt(x, y)` hit-tests a scatter at a position of the pane: the rows
  whose centers lie within the widest mark of the pixel's column are found by a binary search in time,
  and each is placed, sized and shaped as the last frame drew it; the last that covers the pixel is
  the one on top, and their counts sum to the pixel's density. Like `HeatmapSeriesApi.valueAt`, it is
  not part of the crosshair event: a handler reads it at `event.point`.

- **Save and restore** (section 7.2): an indicator input that reads a marks series is saved as the
  series' id and the column, and checked against the columns of the series' type. A restore makes
  the marks series before the bar series and the indicators, which may read them.
- Removing a marks series removes the indicators that read it, as for any series.

## 8. External contract and scope

- `ScatterSeriesApi` and `HeatmapSeriesApi` gain `prepend(data)`, `correct(...)`, and
  `removeMarks({ from, to })`; `setData(data, { datafeed })` changes the datafeed. A heatmap's
  `priceStart` may be one per column, and `update` / `correct` take one for their column.
- `addSeries('heatmap' | 'scatter', { timeline })` lets one or more mark series make the bars of a
  chart without bars: they share a single hidden line series whose bars the engine keeps equal to the
  sorted, deduplicated union of all contributors' buckets (`MarksTimeline`), one per heatmap column or
  per `interval` milliseconds that hold marks (a minute by default for a scatter). Appends, prepends,
  corrections, removals, and removing individual contributors keep the union exact; the hidden line
  series is removed once the last contributing mark series is removed. Like the datafeed, `timeline`
  is not saved with the state.
- The engine protocol gains `prepend`, `correct`, and `delete` marks changes, `bounds` on
  `MarksUpdate`, `level` on `MarksChunk`, `fetchable` and `timeline` on `add`, the `marksRows`
  command, and `marksFetch`, `marksCancel` and `marksRestored` on events.

## 9. Stages and measurement gates

Outside a browser, on the shared M1 (load average 55 when the run began), median of five runs: a
million points take 368 ms to set, 61 ms to take 100,000 older ones in front, 33 ms to lose a tenth
in the middle and 3 ms at the start; letting every chunk but the edges go takes 44 ms, and a chunk
comes back in 5 ms. Counting trades and their VWAP for 16,667 bars over a million points takes
17 ms from scratch and 0.2 ms for an appended trade. Byte-for-byte comparisons of heatmaps whose
grid follows the price, through zooms that merge columns, slots and values, live columns, prepends,
removals and the switch to slots of an automatic range, pass in Chromium (WebGL2 and WebGPU at
DPR 1, 1.5 and 2), WebKit (both at 1 and 2) and Firefox (WebGL2 at 1 and 2). Against `main`,
the existing mark cases keep their frame time; a heatmap with an automatic range goes over to palette
slots after its first frames, its GPU pass p95 a quarter to a third lower on pan and zoom and its
renderer 8 MiB smaller. [measured: [mark history](../benchmarks/mark-history.md)]

## 10. Open questions

- The switch of an automatic value range to palette slots waits 30 draws and makes 262,144 cells a
  draw. Both numbers come from the cost of quantizing on the M1; how often real books set new extremes,
  and what the GPU saves on mobile, would calibrate them.
- A waiting removal or correction is dropped after three rounds of refused marks, 1, 2 and 4 s
  apart. A datafeed that lags behind its source longer than that loses the change (it is reported).
  How long real datafeeds lag after a change at their source would calibrate both.
- Marks taken as changed are checked inside the ranges of the changes only: outside them, the points
  of a scatter chunk holding stand-ins and the cells of heatmap columns are taken as returned, since
  the checksum covers the chunk as it went. Checksums of blocks of a chunk would check them too.
- Scatter changes that reach one chunk let go but do not merge (a change between them touches their
  span) are refused when the datafeed returns them all applied, and the first is dropped after three
  rounds.
- A small scatter change in the middle fetches the side that moves, the chunks at its edges, and the
  points under the coarse chunks let go at the edges of its buckets, which are made whole to be
  spliced: for 30 points of a million let go, 4 chunks of 14 at a fifth of the history, 6 at four
  fifths, 9 in the middle (the edges first, then the side). The side that moves is inherent to rows
  numbered like bars; a coarse chunk at an edge could instead stay let go with its summary moved to
  the cells written into it. A correction that keeps the number of points still moves the rows of a
  coarse level whose cells it changes in number.
