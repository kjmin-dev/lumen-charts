# Stage 3: indicators, as built

What stage 3 built of the [design](../design.md). Each heading below is the section of the
design the text under it belongs to, and section numbers in the text are those of the design.
The measurements are in [docs/benchmarks/stage-3.md](../benchmarks/stage-3.md).

## 5.1 As built in stage 3

**Kernels.** The signature is `(buffer, offset, length, state, carry, params)`, plain numbers and
typed arrays only, so a WASM build can replace a kernel without other changes.

- `buffer` is column-major: the definition's inputs, then its outputs.
- The carry lives in the buffer, in the `carry` input rows in front of `offset`, instead of in a
  separate array. A kernel reads up to `carry` rows back without checking where the slice starts,
  and the whole call is one contiguous region (one block of WASM memory).
- `params` is a sixth argument, in the definition's order.
- `state` is all zeros on a fresh start, and the kernel keeps a flag or a count in it to tell.
- Missing inputs and undefined outputs (warm-up, gaps) are NaN. Windowed kernels output NaN while
  any row of their window is missing. Cumulative ones skip a missing row and output NaN for it.
- Built-ins: SMA, EMA, WMA, RSI, MACD (macd, signal, histogram), Bollinger bands (upper, middle,
  lower), ATR, Stochastic (k, d), VWAP (anchored to UTC days by default) and rolling highest and
  lowest. EMA-like averages are seeded with the simple average of their first `period` values.
- Only `+ - * /` and `Math.sqrt` are used, and since stage 5 `Math.max` and `Math.min` for the
  rolling extremes (exact, and defined for every operand; see "Extremes and the sign of zero"
  below). Each kernel is tested against a brute-force reference, with gaps, warm-up, chains and
  data on both sides of index 0.

**Runner.** One driver runs every kernel, in the engine and in the standalone `computeIndicator`.

- Slices never cross a chunk boundary (global index a multiple of 8,192).
- A windowed definition declares that its outputs depend only on the last `lookback + 1` input rows
  and that its kernel rebuilds its state from the carry. The runner then restarts it with zero
  state at every boundary. Its values become a function of their window alone, whatever row the
  computation started from.
- The runner keeps a checkpoint of state and carry at every boundary it passes, so a computation
  can restart at any chunk: `stateSize + lookback × inputs` numbers per 8,192 rows.

**Determinism, as tested.** These hold bit for bit:

- Incremental updates give the same bits as a full computation over the same rows.
- After a prepend, a windowed indicator recomputed only near the old first bar gives the same bits
  as a full computation over the new history. This is what the boundary restarts buy.
- A cumulative indicator recomputed after a prepend stops only where its state and carry equal, bit
  for bit, the checkpoint the previous computation kept at that chunk boundary. From there on the
  rows cannot differ, so the result is again that of a full computation from the new first bar.

**Extremes and the sign of zero (stage 5).** Every highest and lowest value is taken with
`Math.max` and `Math.min` after a test that skips missing values: in level-of-detail buckets
(`aggregate`, `lineBuckets`), in the bars of a secondary series merged into one main bar, in the
rolling extremes and Stochastic's range, in the pixel columns and the price range of
`SeriesView`, and in the range of a price axis. One rule follows for all of them:

- **Of a set that holds both zeros, the highest value is +0 and the lowest is −0**, wherever they
  are in it (−0 orders below +0, as in IEEE 754 `maximum` and `minimum`). A set of only one kind of
  zero keeps that zero. Nothing else differs from a comparison: the two give the same bits for
  every other input, missing values and infinities included.
- The rule does not depend on order or grouping, so a value has the same bits however it is
  reached: a bucket from its rows or from the four buckets below it, a level built at once or grown
  by ticks, prepends and corrections, a pixel column merged from raw rows or from buckets, a
  rolling extreme in whatever slices its rows are computed, and the engine in a worker or on the
  main thread (the same code).
- Comparisons kept the zero met first. That was the same in most of these places, but not in the
  rolling extremes, which cut rows into blocks from where a slice starts: a window of both zeros
  gave +0 or −0 depending on the slicing (38% of such rows in a test of period 3), against the
  first guarantee above. The rule removes that.
- A WASM port has to use `f64.max` and `f64.min`, which follow the same rule, not a comparison
  and a select.
- Tested with rows that are zeros of both signs with gaps between them: `aggregate` in every
  order, levels grown by prepends, ticks and corrections against brute force and against the same
  rows loaded in two steps, rolling extremes and Stochastic from different starting rows, indicator
  values and their buckets through ticks and a prepend, and view items from raw rows against those
  from every level, all bit for bit.

**Incremental ticks.** All rows but the last are committed: the live runner holds the state and
carry after the second-to-last row.

- A tick that changes the bar still forming computes that row from a copy of the committed state:
  O(state), which is O(1) for the built-ins. The rolling extremes and Stochastic keep no state:
  they take the extreme of the window with the van Herk/Gil-Werman algorithm (three passes, O(1)
  per row in bulk, O(window) for one row), and Stochastic sums its short averages in window order,
  so their bits do not depend on how rows are sliced either.
- A new bar first commits the previous one.
- A correction of an older bar rewinds to the checkpoint of its chunk and recomputes from there,
  in place, if at most four chunks follow and their rows are held. Otherwise it starts a full
  recomputation.
- The changed rows, and the bucket of every level holding them, go into the tick's patch: one
  message for bars and indicators, as section 3 asks.

**Derived series.** Every output is a series on the main timeline.

- Each has its own id, values in chunks aligned with the raw chunks, and a level-of-detail pyramid
  (first, highest, lowest, last), like a line.
- Windows and patches carry them through the existing protocol, so the window cache, levels,
  autoscale and the line renderer work on them unchanged.
- Outputs are drawn as lines, or as histograms (a new series type, also open to application data)
  for MACD's histogram. They overlay the price pane, and autoscale includes them; a histogram's
  base is always in range.

**Recomputations in the background.** Load, a parameter change and a new input recompute an
indicator in full; a prepend recomputes it as far as the new history changes it.

- The job runs in slices of one chunk into storage of its own (values and pyramid), in the order
  indicators were added. That order is topological: an input can only read an earlier indicator,
  so a job waits until the jobs of its inputs are done.
- The live values stay on screen and keep receiving ticks. When the job reaches the end of the
  data it computes the last bar from the current data and swaps everything in at once. Nothing is
  shown half-recomputed, and nothing blanks.
- Corrections behind a running job restart it.
- After a prepend, a windowed indicator recomputes only the rows from the new first bar up to the
  first chunk boundary whose window lies entirely in rows it had before. Those rows are spliced
  in, and their buckets rebuilt, in one step. Near the end of the data it recomputes everything.
- A cumulative indicator recomputes from the new first bar and, at every chunk boundary from the
  old first bar on, compares its state and carry with the live computation's checkpoint there. Once
  they are equal it stops and splices the rows before the boundary the same way. Exponential and
  Wilder averages forget their start within a few thousand rows and a daily VWAP at the next day,
  so a prepend costs about the new rows plus a chunk, not the whole history; a running sum from the
  first bar never converges and is recomputed in full. Kernels therefore keep in their state only
  what later rows depend on (the built-ins clear their seeding sums once seeded).
- An indicator that reads another decides what to recompute when its job starts, after the jobs of
  its inputs: its inputs are unchanged from where the indicators it reads stopped changing.
- The main-thread engine runs these jobs in message tasks, like commands, not in idle time: their
  results are on the way to the screen. Level-of-detail builds still wait for idle time.
- In a worker shared by several charts (section 3), these jobs are part of each engine's background
  work: engines take turns, and none runs while an engine has a command waiting. What a turn
  finished goes out as a notice tagged with that engine's id.

**Notices.** The protocol gains an event that answers no command: values swapped in (the windows
held are stale, and the latest values come as patches), plugin modules loaded, or rows a
recomputation needs fetched. Its `ack` repeats the last command answered.

- Every event says how many indicators are still computing.
- `whenIdle` waits for those to finish and be drawn. `whenApplied` waits only for the data to be
  applied on the main thread.

**Memory limit.** Indicator outputs, their levels and checkpoints are never let go; they count
toward the limit.

- A recomputation that needs rows the limit let go fetches them again through the datafeed, one
  window ahead (16 chunks), and waits while they come back.
- Eviction spares the rows a pending recomputation has yet to read, and lets go again of those it
  has passed. Memory stays near the limit plus that window.
- If the datafeed cannot return the rows, the recomputation is given up: the values on screen stay,
  and the next change tries again.
- Windowed indicators after a prepend read only the new rows and the first chunk, which is always
  held; converging cumulative ones read the new rows and the few chunks before convergence.
- As built in the stage 2 follow-ups: a recomputation may read any series with data, so the rows of
  other series under the main rows it reads next are fetched and kept as well. A failed fetch of
  rows it does not wait for yet is asked for again (after the chart's pause); a failed fetch of the
  rows it waits for gives it up.

**Changes of history** (stage 2 follow-ups, section 8).

- A correction is a tick on an older bar, also when it waited for its bar to come back or the bar
  came back changed at the source, and follows the rule above: in place when recent, a full
  recomputation otherwise.
- Removing bars of another series changes the values merged into the main rows those bars belonged
  to, and is handled like a correction of those rows.
- Removing bars at either end of the main series leaves the other indexes as they are: every
  indicator is recomputed in the background, and the values on screen stay until then. Removing
  bars in its middle re-bases indexes, which drops the values and recomputes them, as a new history
  does.
- A computation starts at the main timeline's first row, which is no longer 0 once bars were removed
  at the head. Slices follow the chunks, so a computation from scratch that should give the same
  bits starts at that row too.

**Plugins.** A custom indicator is a definition: kernel, sizes (`stateSize`, `lookback`, `warmup`)
and plain metadata (inputs, outputs with their style, parameters with bounds, `windowed`).

- `chart.registerIndicators(url)` has the engine `import()` an ES module and register the
  definitions it exports: the default export or `indicators`, one or an array. The import runs in
  the worker, or on the main thread with the fallback. The engine returns the plain metadata, so
  the main thread never needs the kernel.
- Registration is per chart. Charts that share a worker each register the module in their own
  engine, and the worker imports it once. Engines in one worker call the same kernel functions, so
  a kernel keeps what it needs between calls in its state and carry, not in module variables.
- The module is loaded by URL, so it must be a standalone ES module: no bare imports a browser
  cannot resolve.
- CSP: the page's `script-src` must allow its origin. A worker created from a URL follows the CSP
  delivered with the worker script. A `blob:` or `data:` module needs those schemes allowed.
- Bundlers: the engine's `import()` is marked to be left alone (`@vite-ignore`, `webpackIgnore`).
  The application emits the module as a separate file, for example from `public/`, or as a
  separately built entry with a stable URL, and passes `new URL(..., import.meta.url)` or an
  absolute path.

**Custom series and primitives (section 8).** Custom series whose values a kernel computes are
covered by plugins: their outputs are derived series drawn as lines or histograms. Custom renderers
and pane or series primitives were deferred to stage 4, which defined them together with drawings
(section 8, as built in stage 4): an output can now be drawn by a custom renderer.
