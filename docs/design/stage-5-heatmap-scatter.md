# Stage 5: heatmap and scatter series, as built

The series the GPU layer of the [design](../design.md) was deferred for
([stage 5](stage-5.md#62-stage-5-as-decided-and-as-built)), built on the path that decision named:
Canvas 2D through a pixel buffer. Each heading below is the section of the design the text under it
belongs to, and section numbers in the text are those of the design. The measurements are in
[docs/benchmarks/stage-5-heatmap-scatter.md](../benchmarks/stage-5-heatmap-scatter.md).

## 3. Architecture

**Marks.** A scatter point and a heatmap cell are not bars: a scatter has many points per bar and
at any time, a heatmap a column of cells per time. They are called marks here, and a series of
them a mark series. Everything else of the architecture holds for them as it does for bars:

- **Ownership.** The engine holds the marks, in the worker when there is one, in stores of their
  own beside the bar stores (`packages/engine/src/marks/`). The main thread holds a window: the
  rows of one level of detail around the view.
- **One interface.** Three additions to the engine's protocol carry them: a `marks` command (add or
  remove a series, `set` or `append` its data), a `marksWindow` command (the rows a view needs),
  and `marks` on an event (rows: the answer to a window request, or a patch). Data and rows are
  typed arrays, transferred both ways. The commands run inside the engine's command loop, so they
  keep their order with everything else, are answered once each, are time-sliced on the main thread
  (a bulk `set` yields every 32,768 points), and the worker host and the main-thread host need no
  change.
- **Tick path.** An append is answered by one event with what it changed in the window the client
  was sent last: the new points, or the cells of the last time bucket of a coarse level, or the last
  column. The engine keeps, per series, which level and rows that window was; a window that ended
  with the last row of its level grows with every append.
- **Time.** A mark series has times of its own and is not mapped onto the main timeline in the
  engine. The main thread places marks by time on the bars it draws (section 6.3), so nothing of
  a mark series changes when bars are prepended, removed or replaced.
- **Memory.** The stores count toward the engine's memory (`memoryLimit`), but nothing of them is
  let go: a mark series has no datafeed. Under a limit the bars go first.

## 4. Data layer

### 4.4 Scatter store (as built in stage 5)

- Columns: time and price as Float64, value as Float32 (it only colors the point), in chunks of
  65,536 rows: 20 bytes a point. Points are in time order, several may share a time; `set` sorts an
  input that is out of order (stably), `append` refuses a point before the last. A point without a
  finite time and price is refused.
- **Levels of detail.** With 65,536 points the store fixes a grid: price bins a 4096th of the
  price range high, and time buckets that hold 64 points on average. Level 1 holds one row per cell
  of that grid with a point in it, at the cell's center, with the largest value of its points; each
  level above has buckets at least four times as wide and the same bins. A level is a scatter with
  fewer points, so the same rows, window and renderer serve every level.
  - A level is kept only if it has at most three quarters of the rows it was built from. Points
    spread over many bins (a cloud rather than a path) merge only in wide buckets, so the buckets of a
    level are widened by four until rows merge; a level that would be a copy is never stored.
  - Levels above the first are built from the level below, which gives the same cells as the points
    would (buckets nest, bins are shared). A level is added above the top one while that has more
    than 16,384 rows.
  - An appended point lands in the last bucket of every level, found through a map from the bins
    of that bucket to their rows. This is constant work per point and level.
  - The grid stays until the next `set`. Prices outside the first range get bins of the same height.
- **The level for a view** is chosen by the engine from what the client says of it (times in view,
  milliseconds and price per device pixel, the most rows it wants): the coarsest level whose
  buckets are no wider than a device pixel and whose bins are no taller, so nothing visible is
  lost; the points themselves when no level is that fine. If that is more rows than the client
  wants (2M for the view and half a screen on either side), coarser levels are tried: cells are then
  wider than a pixel, and the frame keeps its budget (principle 1).
- Not built: a count per cell (the density of points, as a color), and a size per point.

### 4.5 Heatmap store (as built in stage 5)

- A heatmap has one price grid for the whole series (`priceStart`, `priceStep`, `rows`), set by
  `set`. A column is a time (Float64) and `rows` cells (Float32, NaN for no value), in chunks of
  about 65,536 cells. Times strictly increase; a column at the last column's time replaces it.
- **Levels of detail.** Level `k` merges `4^k` columns by index into one: its time is the first
  member's and each cell the largest of its members' cells (a sum would make cells four times as
  bright at every level change, as with volume in section 4.2). Levels exist while the level below
  has more than 512 columns. A changed column rebuilds its bucket at every level from all members
  (at most four per level), so a column replaced by lower values lowers the levels.
- **The level for a view** is the coarsest that still has a column per device pixel, and coarser
  while the cells are more than the client wants (6M). Rows are not merged in the store: the
  renderer merges cells that share a pixel row.
- Not built: a grid that follows the price (a first row per column). A book over a long history
  needs the whole price range in its grid, at 4 bytes a cell.

### 4.6 Window of a mark series (as built in stage 5)

- The main thread holds, per series, rows `[start, start + count)` of one level
  (`MarksWindow`): the typed arrays the engine sent, grown by half when a patch needs room.
- A frame asks for rows when the view comes within a quarter of a screen of the edge of what was
  asked for (half a screen of margin for a scatter, one for a heatmap), when it was zoomed by two or
  more in time or in price (another level may fit), when appends grew the window by half, or after
  a `set`. The request names the rows held, and the engine answers without rows when they still
  serve.
- Meanwhile the frame draws what it holds. Unlike the bars, no coarse level is kept beside the
  window, so a jump far away shows nothing of the series until the rows arrive, usually by the
  next frame.

## 6. Render layer

### 6.3 Heatmap and scatter series (as built in stage 5)

**A pixel buffer per series.** A mark series owns an `ImageData` the size of the pane and a canvas
of that size. Marks are written into the buffer as 32-bit pixels, the buffer is handed to the
canvas with `putImageData`, and the canvas is composited onto a layer of the pane with one
`drawImage`, at the series' `opacity`. The second canvas is what makes the pixels blend with the
grid and the series under them (`putImageData` replaces pixels). Buffer and canvas are kept between
frames, nothing is allocated per frame, and the canvas counts toward the canvas budget.

**Layers.** Each series draws through the primitive interface of stage 4: a heatmap as a `bottom`
primitive (the series layer, above the grid and below the series), a scatter as a `normal` one (the
drawings layer above the series, with `zIndex` −1, below drawings).

**Three kinds of frame.** A frame compares what the picture was drawn with (the mapping of times,
the price mapping, the rows, the value range, the options) with what holds now:

- Nothing differs: the canvas is composited as it is. A tick of the bars costs a heatmap one
  `drawImage`, and a scatter nothing (its layer is not drawn).
- Only rows changed (an append): the changed rows are written and handed over. A point added to a
  scatter writes that point and uploads its rectangle. A heatmap column writes from the column
  before it (whose right edge is the new column's left) to the right edge of the picture.
- Otherwise the picture is drawn again from the rows in view: a pan, a zoom, a new price range, new
  bars, new options.

**Partial redraw of the series layer** (section 6.2): a heatmap is a `bottom` primitive, so with one
the series layer is redrawn in full on every tick, as section 6.2 has it for any such primitive.
The heatmap's own part of that is the one `drawImage`. A scatter is not on the series layer and
leaves its partial redraw as it is.

**Time to pixels.** Marks are placed on the bars of the frame (`TimeMap`): a bar's time is at the
bar's center, a time between two bars the same fraction of the way between their centers, as
`PaneView.timeToLogical` places it, and times beyond the bars held go on at the pace of the bars
there. At a coarse level of the bars the knots are the buckets' first rows, which is off by less
than a bucket is wide, under a pixel. Marks are in time order, so a renderer walks the bars once.
A scatter point may instead be placed from the start of its bar (`barAlign: 'start'`); heatmap
columns always are.

**Scatter.** A point is stamped with its center on the device pixel its time and price round to:
a square, or the pixels of a disc, of `pointSize` device pixels. A later point overwrites an
earlier one. Colors come from a table of 256 pixels built from the palette once.

**Heatmap.** Column and row edges are rounded to device pixels once, so cells share edges and leave
no seam. A pixel row is computed once per cell row (the cell's slot in the color table for each
device column) and copied down the rows of pixels the cell covers; values are turned into slots
once per window, not per frame. Where several cells share a pixel, across or down, the pixel takes
the highest.

**What a pixel buffer cannot do** is blend marks with each other: points do not accumulate where
they overlap, and edges are not antialiased. That, and more marks than the measurements below
allow, is what the WebGL2 layer of section 6 is for.

## 7. Interaction

- **Save and restore** (section 7.2): heatmap and scatter series are entries of the state's `series`
  like the others, with `type` `heatmap` or `scatter` and their options. `order` is kept but does not
  place them among the other series: heatmaps are below and scatters above. A restore checks them
  with the rest of the state, before anything changes.
- **Hover**: `HeatmapSeriesApi.valueAt(time, price)` reads the cell drawn at a point from the
  window. Nothing is hit-tested, and a scatter has no readout.

## 8. External contract and scope

- `addSeries('heatmap' | 'scatter', options)` returns the series' own interface
  (`HeatmapSeriesApi`, `ScatterSeriesApi`): `setData`, `update`, `append`, options, the price scale.
  They are listed by `markSeries()`, not `series()`, whose entries all take bars, indicators and
  renderers.
- Not built: a datafeed for marks (history on demand), `prepend`, removing marks, indicators over
  them, and a chart whose timeline comes from a mark series (it needs a series with bars).

## 9. Stages and measurement gates

Stage 5, heatmap and scatter (measured, [stage 5 heatmap and scatter](../benchmarks/stage-5-heatmap-scatter.md)):
On the M1 worker, 100k scattered points and 240k heatmap cells fit the 8 ms pan and zoom budget. Incremental updates fit the 4 ms frame budget up to 1M points and 1.44M cells.

## 10. Open questions

- Open after stage 5 (heatmap and scatter): Full redraws miss 8 ms at 300k scattered points on zoom and at 1.44M heatmap cells on pan and zoom. These cases are the targets for a GPU renderer.
