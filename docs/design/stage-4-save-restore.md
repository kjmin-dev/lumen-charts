# Stage 4: save and restore, as built

What the save and restore part of stage 4 built of the [design](../design.md). Each heading below is the section of the
design the text under it belongs to, and section numbers in the text are those of the design.
The measurements are in [docs/benchmarks/stage-4-save-restore.md](../benchmarks/stage-4-save-restore.md).

## 7.2 As built in stage 4 (save and restore)

- **API.** `chart.saveState()` returns a `ChartState` and `chart.restoreState(state)` takes it back
  (`packages/core/src/state.ts`). Both take `{ parts }` to save or restore some of the sections
  (`options`, `series`, `indicators`, `drawings`, `view`), and a state need not hold every section:
  what is left out stays as it is on the chart. Series and indicators have an `id` for this (given
  when they are added, or `series-1`, `indicator-1`, ... by the chart), and `chart.series()` and
  `chart.indicators()` list them.
- **Format.** Plain JSON with a top-level `version` (`CHART_STATE_VERSION`, 1). A state of any other
  version is refused; keys added later are optional, and unknown keys are ignored. Each drawing is
  the `DrawingState` of section 7.1 with its own version. What a state holds is what was configured,
  never bars:

  | Section      | Holds                                                                                                                                                            |
  | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `options`    | The options applied to the chart, not the defaults or the theme's colors under them: the theme stays a theme. Price scales and their modes are among them.       |
  | `series`     | `id`, `type`, every option (`priceScaleId` among them), `pane` (0) and `order`, the place among series and indicators in the drawing order.                      |
  | `indicators` | `id`, the definition's `name`, the `source` and `inputs` by id (`{ series }` or `{ indicator, output }`), every parameter, every option of each output, `order`. |
  | `drawings`   | `DrawingState[]`, bottom to top.                                                                                                                                 |
  | `view`       | `timeRange`: the times at the left and right edge of the pane. `priceRanges`: the range of each scale that does not autoscale (autoscale itself is an option).   |

- **What is not saved.** Bars, and what is not data: functions and what belongs to the page. The
  size (`width`, `height`, `autoSize`), `worker` and `memoryLimit` describe the page and the device,
  so a restore leaves them as they are, like the formatter functions of `localization`. A series the
  chart already has (same `id` and type) keeps its bars, datafeed, custom renderer and primitives; a
  series the restore adds has none of them until the application hands them over. Indicators are
  saved by the name of their definition: a custom one must be registered (`registerIndicators`)
  before the restore, which otherwise refuses the state. Selection, hover and a tool in progress
  are not state.
- **The view is saved as times.** Like drawing points (section 7.1), the edges of the pane are
  times, whole milliseconds: between two bars by interpolation, past either end at the median
  spacing of the 64 bars there. A restore maps them back with the time index, so the same times are
  in view whatever history is loaded, at any resolution; bar spacing and right offset follow from
  the two times and the pane's width, which is why they are not stored. Saving asks the engine
  nothing: past an end whose spacing the main thread has not been told, it takes the median of the
  raw rows held there (the engine's own answer when 65 rows are held) or, zoomed out to a coarse
  level, the spacing of the buckets at that end: an approximation, at a zoom where a bar is a
  fraction of a pixel. A restore
  places the times at once when the raw rows around them are held, and otherwise after one `resolve`
  round trip; into a chart without bars it waits for them. `fitContent` and the other view calls
  after a restore win over a view still waiting.
- **All or nothing.** The whole state is checked before the first change (`planRestore`): the
  version, the kind of every value against the defaults (a finite number, a string or one of its
  choices, a boolean), unique ids, that every series, indicator and output an indicator reads will
  be there, parameter bounds, the time zone, locale and schedule (compiled on the side). An error
  names the place (`series[1].options.visible must be a boolean`). Applying cannot refuse anymore.
- **One frame.** While a state is applied, invalidations only note the highest level asked for, and
  one invalidation follows at the end, so a restore costs one frame however many series, indicators
  and drawings it holds. Series are matched by `id` and type and keep their bars; indicators are
  kept, and only take the state's options, as far as the chart's list and the state's start with the
  same ones (id, definition, source), and the rest are removed and added in the state's order, which
  keeps the engine's order topological. A kept indicator whose parameters and inputs did not change
  is not computed again. Drawings are replaced, with `removed` and `created` events. Saving reads
  the model and draws nothing.
- Measured with 1,000 drawings and 5 indicators on 1M candles
  ([stage 4 save and restore](../benchmarks/stage-4-save-restore.md)): saving takes 0.07 ms, and a
  restore 1.7–1.8 ms in the call and 1.2 ms in its one frame.

## 9. Stages and measurement gates

Stage 4, save and restore (measured, [stage 4 save and restore](../benchmarks/stage-4-save-restore.md)):
with 1,000 drawings and 5 indicators on 1M candles, `saveState` takes 0.07 ms and `restoreState`
3.0–3.1 ms of JavaScript in all, in one frame. Stage 4 has no gate for it.
