# Stage 2 follow-ups

Stage 2 left five things open ([stage-2.md](stage-2.md)): the rest of the datafeed contract
(corrections, deletions, resolution changes, cancelling requests), the memory limit with several
series, a memory floor held up by the time column, history that came back two frames after the
view changed, and a 55.8 ms outlier among the 1M-candle prepends. This document gives what changed,
measured against `main` before, and what it costs. The design choices are in section 8 of the
[design](../design.md); the API is in the README ("History on demand").

The work was measured on `main` at `591934d` and then rebased onto stage 3 (indicators, `cab3cc9`),
where corrections, deletions and rows let go now also reach the indicators. The section "Stacked on
stage 3" gives what that changed and the cases measured again on top of it.

The short version, on 10M line points with a datafeed in the page:

- **Memory floor: 111 → 34.5 MiB.** A chunk let go keeps a 128-byte summary instead of its time
  column, so with a limit far below what fits, only the levels of detail and the chunks around the
  view stay.
- **History let go is drawn one frame after the jump instead of two**: 16.5–16.6 ms instead of
  33.3 ms in every run, with and without the worker. Windows that need no fetch arrive one frame
  sooner too.
- **The limit holds with several series.** Two 10M-point series with datafeeds and a 1M-point one
  without, under 256 MiB: 261 MiB retained instead of 409 MiB (before, the limit did not apply).
- **Operations on history let go**: a correction is drawn in the next frame (15–18 ms) whether or not
  its bar was let go; removing 10 bars in the middle takes about 90 ms (up to 133 ms), since the bars
  on one side move and their levels are rebuilt; a change of resolution takes 23–33 ms and the old
  datafeed is not called again.
- **No change** in the gate cases (ticks, prepends, loads) beyond the spread of the runs. Pan and
  zoom frames take the same time within one or two timer steps (5–10 µs, at most 3%) once both
  sides run in the same of the machine's two states; see "Gate cases".
- **The prepend outlier** is the engine's own work for 1M candles (16 to 80 ms in Node, on both
  versions) crossing a frame boundary. Not fixed; see "The prepend outlier".
- **On top of stage 3**, indicators recompute after corrections and deletions to the bits of a
  computation from scratch (unit tests), and the stage 3 gate cases and the refetch scenario measure
  the same as before the rebase, within runs on a heavily loaded machine.

## Conditions

Apple M1 (8 cores) on AC power, headless Chromium 156.0.8078.4 (new headless mode, GPU
rasterization), viewport 1280 × 720, DPR 2, Node 26.13.1. Tables give the median with the range of
the runs in parentheses; times in ms unless a unit is given.

- **Before** is `main` at `591934d`, measured with this branch's harness through `--packages` (the
  `packages/` directory of an export of that commit). **After** is the branch at `4f13b10` for the
  first round and at `bea8b0a` for the second (see "Letting go in slices"). The JSON files record
  the commit; the "uncommitted changes" they mention are documentation.
- **Alternating runs.** Before and after ran one invocation each, pass after pass;
  `pnpm bench:merge` joined the passes of each side. The refetch scenario ran once per side with two
  repeats: its latencies come in whole frames and its memory does not drift.
- **The machine was busy.** The load average was 3.8–4.3 during the first gate pass, then rose to
  26–47 when an unrelated build started on the machine (CPU idle 0% in most of those runs), and was
  7–18 in the second round. Benchmarks never overlapped each other. Each table names the load
  average of its runs; the JSON files have them per invocation (`environment.machine`).
- **Two rounds.** The first round (gates, refetch, prepends) ran at `4f13b10`. It showed a long task
  when a large history is let go (see "Letting go in slices"); after the fix, the second round ran
  the refetch scenario again and two more passes of the frame cases at `bea8b0a`.

Files:

- [stage-2-follow-ups-refetch-before.json](stage-2-follow-ups-refetch-before.json) and
  [stage-2-follow-ups-refetch-after.json](stage-2-follow-ups-refetch-after.json): the refetch
  scenario, 2 repeats per side (after: the second round, at `bea8b0a`);
  [stage-2-follow-ups-refetch-after-first.json](stage-2-follow-ups-refetch-after-first.json): the
  first round of the branch, at `4f13b10`.
- [stage-2-follow-ups-gates-before.json](stage-2-follow-ups-gates-before.json) and
  [stage-2-follow-ups-gates-after.json](stage-2-follow-ups-gates-after.json): gate cases, 2 passes.
- [stage-2-follow-ups-frames-before.json](stage-2-follow-ups-frames-before.json) and
  [stage-2-follow-ups-frames-after.json](stage-2-follow-ups-frames-after.json): the frame cases
  again, 2 more passes.
- [stage-2-follow-ups-prepend.json](stage-2-follow-ups-prepend.json): 1M-candle prepends, 5 runs.
- [stage-2-follow-ups-s3-before.json](stage-2-follow-ups-s3-before.json) and
  [stage-2-follow-ups-s3-after.json](stage-2-follow-ups-s3-after.json): stage 3 tick to applied,
  prepends with indicators and ticks, on `cab3cc9` and on the rebased branch, 2 passes;
  [stage-2-follow-ups-s3-main-before.json](stage-2-follow-ups-s3-main-before.json) and
  [stage-2-follow-ups-s3-main-after.json](stage-2-follow-ups-s3-main-after.json): two of those cases
  again with the engine on the main thread, 2 passes of 2 runs;
  [stage-2-follow-ups-s3-refetch.json](stage-2-follow-ups-s3-refetch.json): the refetch scenario on
  the rebased branch.

## The refetch scenario

Stage 2's scenario: 10M line points with a datafeed that serves them from the page and answers at
once, so the latencies are the chart's own. After the load the engine builds its levels and lets go
of chunks; then the view jumps to 20 regions spread over the oldest 90% of the history, 2,000 bars
in view, and each jump is timed until the region is drawn. Three cases are new:

- **`1mib/jumps`**: the same with a limit of 1 MiB, far below what fits: everything that can go
  goes, so retained memory is the floor and every jump fetches.
- **`256mib/several`**: three line series on the same times: the main one and a second one with
  datafeeds (10M points each), and a third one of 1M points (the newest tenth) without a datafeed.
- **`128mib/ops`**: three jumps, then corrections, deletions and a change of resolution on the
  history mostly let go (see "Operations").

| Case                  | Adapter      | Shown p50, before → after           | Frames | Fetches per jump | Jumps without fetch | Retained after load (MiB) | After the jumps (MiB) |
| --------------------- | ------------ | ----------------------------------- | ------ | ---------------- | ------------------- | ------------------------- | --------------------- |
| 128 MiB               | lumen-worker | 33.3 (33.2–33.3) → 16.6 (16.6–16.6) | 2 → 1  | 1 → 0            | 4 → 12 of 20        | 130 → 130                 | 131 → 131             |
| 128 MiB               | lumen-main   | 33.3 (33.3–33.3) → 16.6 (16.6–16.6) | 2 → 1  | 1 → 0            | 4 → 12 of 20        | 130 → 130                 | 130 → 130             |
| 1 MiB (floor)         | lumen-worker | 33.3 (33.3–33.3) → 16.6 (16.6–16.6) | 2 → 1  | 1 → 1            | 0 → 0               | 111 → 34.5                | 111 → 35.3            |
| 1 MiB (floor)         | lumen-main   | 33.3 (33.3–33.3) → 16.6 (16.6–16.6) | 2 → 1  | 1 → 1            | 0 → 0               | 110 → 90.6 (86.6–94.6)    | 111 → 34.9            |
| 256 MiB, three series | lumen-worker | 33.3 (33.3–33.3) → 16.5 (16.5–16.6) | 2 → 1  | 0 → 2            | 20 → 6              | 409 → 261                 | 410 → 262             |
| 256 MiB, three series | lumen-main   | 33.3 (33.2–33.3) → 16.5 (16.5–16.5) | 2 → 1  | 0 → 0            | 20 → 14.5           | 388 → 391                 | 409 → 262             |

Before: load average 43–47; after (second round, `bea8b0a`): 7–12. Shown p95 after is at most
18.1 ms (35.2 ms before) and the slowest jump of all runs after took 18.6 ms. A fetch asks for
16,384 rows of a series (two chunks: the window around a 2,000-bar view). The first round of the
branch (`4f13b10`, load average 15–37) gave the same latencies, and the same fetch counts except for
lumen-main with three series (2 fetches per jump, 7 jumps without); it differs where noted below.

### Memory floor

- **111 → 34.5 MiB at the floor.** Before, a chunk let go kept its time column, 8 bytes per bar:
  76 MiB for 10M points, on top of 33 MiB of levels. Now it keeps a summary of 128 bytes (first and
  last time, two 32-bit checksums of the times, one of the values, and for a secondary series the
  time of every 16th bar): 0.15 MiB for the 1,221 chunks. What stays is the levels, the first and
  last chunk, the chunks of the window around the view, and about 1 MiB the limit does not count
  (scratch buffers, JavaScript objects).
- **On the main thread the floor is reached later.** lumen-main sampled 87–95 MiB 1.5 s after the
  load (34.1 MiB in the first round): the summaries are now computed in slices between commands
  (see "Letting go in slices"), on the main thread in idle callbacks of 4 ms, and were not all done
  yet. After the jumps it is at 34.9 MiB.
- **Lookups across chunks let go** use the chunk boundary times, which place any time before, inside
  or after a chunk. Only a time strictly inside a chunk without its times has no exact row; what
  needs one waits for the chunk (a correction there) or works with the boundary (the slot of a
  secondary bar at a chunk start). The main series' indexes of times come from the levels, which
  keep the time of every 16th bar. Rows that come back are checked by count, first and last time,
  the checksum and the times of every 16th bar.
- **With the same 128 MiB limit, fewer chunks go**: each frees 128 KiB instead of 64 KiB, so about
  450 of 1,221 chunks are let go instead of about 900, and 12 of the 20 jumps land in rows still
  held (4 before). The 1 MiB case is the one where every jump fetches.
- **The main series keeps its time column while other series have data** (merging their bars into
  main bars takes every main time), so the floor with several series is higher: 76 MiB of main
  times more for this case.

### Several series

- **Before, the limit did not apply** with more than one series: 409 MiB for the three series.
  After, the worker case stays at its 256 MiB limit (261 MiB retained, the same 2–5 MiB on top as
  with one series). Every jump fetches from both series with a datafeed, 32,768 rows, and a raw
  window waits until the rows of every series are back, so no series is ever drawn from rows it
  does not hold. The series without a datafeed is never let go.
- **lumen-main had not reached the limit when memory was sampled after the load** (391 MiB): on the
  main thread the levels are built in idle time, and 3 s after the load the build of three series
  was not done. Most jumps then landed in rows not yet let go (14.5 of 20 without a fetch). It is
  at the limit after the jumps (262 MiB).
- **Its first jump** (not in the table) took 63 ms (49–77), against 90 ms (41–139) before; it
  finishes the build of the levels the view needs. In the first round it took 231 ms (194–268): the
  jump finished the build and then let go of about 150 MiB in one task, which `bea8b0a` changed.

### One frame instead of two

Before, the first frame after a jump asked the engine for the window and drew the finest level
meanwhile; the window came for the second frame. Now the chart asks when the view changes, in the
call that changes it: the engine asks for the rows it let go, the chart calls the datafeed and hands
them back, and the window is there before the next frame. The same holds for windows that need no
fetch, which is why the three-series case before took two frames with no fetches at all.

During continuous scrolling this asks for nothing more than before: the request uses the window
plan of the frame (a window covers two screens on each side and is renewed when less than half a
screen is left), at most once per change of the view, and the frame finds it planned. A chart
outside the viewport asks in the frame that draws it once it is back. With a datafeed over the
network, its round trip adds to the frame.

## Operations

On the `128mib/ops` case after the jumps. The source changes first, as a server would, then the
chart is told; each operation is timed from the call until the chart has settled. Corrections:
5 bars near the view (held) and 5 far from it (let go). Deletions: 10 bars at 15%, 50% and 80% of
the history. Resolution: `setData` with every fifth bar (2M points) and a datafeed for them.

| Adapter      | Correction, held p50 | Correction, let go p50 | Correction, let go max | Removing 10 bars p50 | Removing 10 bars max | Resolution change | Old datafeed calls after |
| ------------ | -------------------- | ---------------------- | ---------------------- | -------------------- | -------------------- | ----------------- | ------------------------ |
| lumen-worker | 16.4 (16.3–16.4)     | 16.3 (16.1–16.5)       | 17.7 (17.7–17.7)       | 92.1 (88.0–96.2)     | 128 (123–133)        | 23.5 (23.1–24.0)  | 0                        |
| lumen-main   | 15.7 (14.8–16.7)     | 17.4 (16.6–18.2)       | 17.7 (16.6–18.7)       | 90.6 (90.4–90.8)     | 127 (127–128)        | 33.3 (33.3–33.4)  | 0                        |

Second round, load average 7–12, 2 repeats; the first round gave the same within 3 ms, except a
resolution change on the main thread (19.4 ms, 13.4–25.4).

- **A correction of a bar let go costs the same as one of a bar held**: the next frame. It waits for
  the bar's chunk to come back, here at once, and then rebuilds its buckets from all members; it
  holds up nothing else.
- **Removing bars in the middle moves the bars on one side**, the side with fewer bars let go and
  then the shorter one, and starts a new epoch. Every bucket on that side changes, so its levels are
  rebuilt, and the chart takes new windows: about 90 ms, up to 133 ms, for 1.5M to 5M moved bars,
  after fetching the rows let go on that side. Bars at either end are cut off without moving anything (not timed here). A
  tombstone instead would have cost nothing to move but left a slot on the ordinal scale; design
  section 8 gives the reasons.
- **A change of resolution** drops the series' requests (aborting them), waiting operations,
  windows and levels, and loads the new history. No request reached the old datafeed afterwards.

## Letting go in slices

Measuring showed a cost the summaries bring: a chunk's summary takes a pass over its rows. In Node
on this machine (load average 17), letting go of 152 MiB of a 10M-point line in one call took
133, 144 and 192 ms in three runs. That happens once after a large load, in one task: on the main
thread a long task, and in the worker a delay for whatever command comes next. `bea8b0a` lets go of
at most 32 chunks per command or background step (about 3 ms) and leaves the rest to the host's
background slices, between commands.

## The prepend outlier

Stage 2 saw one 1M-candle prepend (worker) shown after 55.8 ms where the others took 31–44 ms. It
reproduces, on both versions:

| Run                         | Load average | Shown p50 per run (ms)       | Worst prepend of the runs (ms) |
| --------------------------- | ------------ | ---------------------------- | ------------------------------ |
| Gate pass 1, before / after | 4–12         | 35.2 / 36.0                  | 36.4 / 43.9                    |
| Gate pass 2, before / after | 15–47        | 55.3 / 38.5                  | 56.7 / 49.0                    |
| After, 5 runs of 5 prepends | 13–15        | 48.9, 51.0, 49.3, 48.1, 45.5 | 74.9                           |

The time is the call (6–10 ms on the main thread, copying 48 MB of columns to the worker), the
engine's work, and the frame after it. The engine's work alone, in Node with the same data
(prepends of 1M candles onto 1M to 7M): 15.7–50.9 ms on `591934d` (median 25.4) and 17.3–80.0 ms on
the branch (median 25.2), 14 prepends each, alternating. It stores 1M rows and builds their levels
before it answers, since the view (1M bars, level 256) draws from them; each prepend allocates about
50 MB, and garbage collection and the load of the machine spread it. When it takes longer than the
rest of the second frame, the batch is shown in the third, at about 50 ms. Not fixed: answering
before the levels are built would show an empty half of the view, and a pool of chunk buffers to
spare the collector is a larger change than this outlier warrants.

## Gate cases

Before and after alternately, 2 passes. The targets of stages 1 and 2 hold in every run of both
sides (tick average 0.1 ms, frame JavaScript p95 16 ms, prepend shown 100 ms).

| Case                       | Metric                          | Pass 1, before → after    | Pass 2, before → after    |
| -------------------------- | ------------------------------- | ------------------------- | ------------------------- |
| tick, 1M candles, last 200 | `update()` mean (µs), worker    | 0.79 → 0.71               | 0.29 → 0.29               |
| tick, 1M candles, last 200 | `update()` mean (µs), main      | 0.68 → 0.76               | 0.31 → 0.32               |
| tick, 1M candles, all      | `update()` mean (µs), worker    | 0.64 → 0.72               | 0.29 → 0.29               |
| tick, 1M candles, all      | `update()` mean (µs), main      | 0.56 → 0.66               | 0.37 → 0.30               |
| prepend 1M to 10M line     | Shown p50, worker / main        | 26.9 / 28.7 → 29.0 / 17.2 | 27.7 / 28.5 → 26.2 / 28.4 |
| prepend 10k to 1M candles  | Shown p50, worker / main        | 16.9 / 17.0 → 17.2 / 17.1 | 16.9 / 17.0 → 16.9 / 16.9 |
| load, 10M line             | Warm first frame, worker / main | 50.2 / 49.2 → 50.9 / 49.2 | 89.1 / 50.0 → 82.5 / 67.9 |
| load, 1M candles           | Warm first frame, worker / main | 16.8 / 17.0 → 33.5 / 17.0 | 33.6 / 15.7 → 33.6 / 17.0 |

Load averages: pass 1 3.8–11.8, pass 2 15.5–46.6. Load times move in steps of a frame, as in
stage 2. The tick figures differ by a factor of two between the passes, on both sides alike.

**Pan and zoom frames**, 10M line points, frame JavaScript p50 (ms), before → after. Passes 1 and 2
are the gate passes above; passes 3 and 4 ran the frame cases alone, load average 9.1–17.9.

| Motion, bars in view | Adapter      | Pass 1        | Pass 2        | Pass 3        | Pass 4        |
| -------------------- | ------------ | ------------- | ------------- | ------------- | ------------- |
| pan, 20,000          | lumen-worker | 0.895 → 0.665 | 0.335 → 0.385 | 0.370 → 0.375 | 0.370 → 0.375 |
| pan, 20,000          | lumen-main   | 0.830 → 0.905 | 0.350 → 0.380 | 0.370 → 0.380 | 0.370 → 0.380 |
| zoom, 20,000         | lumen-worker | 0.385 → 0.895 | 0.345 → 0.380 | 0.375 → 0.380 | 0.380 → 0.385 |
| zoom, 20,000         | lumen-main   | 0.370 → 0.865 | 0.350 → 0.380 | 0.385 → 0.380 | 0.375 → 0.380 |
| pan, all 10M         | lumen-worker | 0.230 → 0.615 | 0.220 → 0.240 | 0.230 → 0.235 | 0.230 → 0.235 |
| pan, all 10M         | lumen-main   | 0.235 → 0.650 | 0.230 → 0.250 | 0.235 → 0.235 | 0.230 → 0.240 |
| zoom, all 10M        | lumen-worker | 0.260 → 0.660 | 0.255 → 0.265 | 0.255 → 0.255 | 0.260 → 0.255 |
| zoom, all 10M        | lumen-main   | 0.255 → 0.635 | 0.245 → 0.250 | 0.250 → 0.255 | 0.250 → 0.260 |

- **Pass 1 is the two states** described in [shared-resources.md](shared-resources.md): runs of the
  same code differ by a factor of two to three. The after side ran in the slow one in pass 1 (and
  the before side in pan 20,000); that is why passes 3 and 4 were added.
- **With both sides in the fast state**, after is higher in 20 of 24 pairs: by 5–50 µs in pass 2 and
  by one or two steps of the 5 µs timer in passes 3 and 4 (at most 3%). The likely cause is the
  window plan that now also runs when the view changes, a few comparisons per change; it was not
  broken down. p95 stays below 0.49 ms in passes 2–4 on both sides, against a target of 16 ms.

## Stacked on stage 3

Stage 3 (`cab3cc9`) added indicators computed in the engine, with hooks for ticks, prepends, new
histories and rows let go. The branch was rebased onto it commit by commit; the engine of this
branch took over those hooks, and `18b0dcd` connects what stage 3 could not know about:

- **Corrections** reach the indicators through the tick path, also those that waited for their bar
  or came back changed at the source: recomputed in place when recent, in the background otherwise.
- **Deletions.** Removing bars of another series changes the main rows its bars merged into and is
  handled like a correction of them. Removing bars at either end of the main series recomputes every
  indicator in the background with the old values on screen. Removing bars in its middle re-bases
  indexes, which drops the values and recomputes them, as a new history does.
- **Rows let go.** A recomputation keeps and fetches the rows of every series it reads, not only the
  main one; rows it asks for come with notices (`fetch` and `cancel`). A failed fetch of rows it waits
  for gives it up, as in stage 3; one of rows it reads later is asked for again after the chart's
  pause. Stage 3's memory tests now count chunks let go as their times and values (16 bytes per line
  bar), and hand rows back by request id.
- **Tests** (`indicator-history.test.ts`) compare the derived series after a held and a let-go
  correction, deletions in the middle, at the head and at the tail (with a chained indicator), and
  deletions and corrections of another series, with a computation from scratch, bit for bit. A
  computation from scratch has to start at the engine's first row: slices follow the chunks, and a
  windowed kernel sums from the start of a slice, so after bars were removed at the head (first row
  10, not 0) one that starts at 0 differs in the last bits. Removing any of the hooks above fails
  these tests.

**The cases the integration could affect**, before (`cab3cc9`) and after (`18b0dcd`) alternately, 2
passes. The load average was 9–51 (40.6–22.8, 22.8–14.4, 13.6–8.9 and 8.9–50.5 per invocation).

| Case, 20 indicators on 1M candles                | Adapter      | Before       | After        |
| ------------------------------------------------ | ------------ | ------------ | ------------ |
| Tick to applied p99, latest 200 bars (gate 4 ms) | lumen-worker | 3.41, 3.04   | 3.55, 3.53   |
| Tick to applied p99, all 1M bars                 | lumen-worker | 4.40, 4.24   | 4.29, 4.69   |
| Tick to applied p99, latest 200 bars             | lumen-main   | 0.270, 0.235 | 0.405, 0.365 |
| Tick to applied p99, all 1M bars                 | lumen-main   | 0.230, 0.270 | 0.255, 0.430 |
| Prepend 10k, shown p95 (gate 1 s)                | lumen-worker | 54.0, 53.9   | 53.2, 53.3   |
| Prepend 10k, shown p95                           | lumen-main   | 37.5, 36.1   | 36.7, 36.9   |
| Prepend 1M, shown p95                            | lumen-worker | 528, 540     | 511, 747     |
| Prepend 1M, shown p95                            | lumen-main   | 573, 617     | 588, 705     |

Times in ms, one value per pass. Ticks on 1M candles without indicators (`update()` mean 0.36–0.75
µs) are the same on both sides.

- **The worker cases are the same**: tick to applied with all 1M bars in view sits at the 4 ms gate
  on both sides, as stage 3 reported. The 747 and 705 ms prepends are from the last invocation, whose
  load average rose from 9 to 51.
- **Tick to applied on the main thread** came out higher after in both passes. Two more passes of
  two runs each with only that case and the 10k prepend (load average 25–58) gave p99 0.250, 0.265,
  0.235 and 0.260 ms before and 0.410, 0.250, 0.410 and 0.390 ms after: higher in three runs of four,
  by about 0.15 ms, at a tenth of the gate. The engine's own time per tick with 20 indicators is the
  same on both versions (in Node, 3 runs each alternating: median 0.065–0.072 ms against
  0.067–0.073 ms), so the difference, if it is one, is on the chart's side; it was not broken down.
- **10k prepends on the main thread** are shown one or two frames after the call on both sides
  (p50 19–35 ms; the same split appears in stage 3's own runs), so their p50 is not compared.

**The refetch scenario on the rebased branch** (2 repeats, load average 86–183): every jump is drawn
in one frame (shown p50 16.5–16.7 ms) and the worker's memory is the same as before the rebase (130,
34.6 and 261 MiB after the load). The main thread's samples after the load are higher (103–171 MiB
at the floor, 374–694 MiB with three series): its idle slices had done less of the letting go after
1.5 and 3 s on a machine that busy, and it is at the limit after the jumps (34.9 and 262 MiB).
Removing 10 bars took 106 and 126 ms (p50), against about 91 ms at a load average of 7–12.

## Known limits

- **Answers for chunks a deletion removes bars from** are checked by the times kept (every 16th bar
  and the chunk boundaries), not by the checksum, since the source may already lack the removed
  bars. A bar missing or added next to the removed range, between two kept times, is not caught.
  When several deletions wait on one series and their bars come back as one gap, the series is
  re-based after the last of them.
- **Waiting operations block their series.** A deletion, or a new main timeline while other series
  have chunks let go, waits until every row it reads or moves is back, and later operations of that
  series wait behind it. A new main timeline then holds the rows of every series at once, briefly
  above the limit.
- **The main series keeps its time column** while other series have data, so the floor with several
  series is 8 bytes per main bar higher.
- **A retry after a failed fetch** comes after a pause that grows from 1 s to 30 s; `whenIdle()` does
  not wait for it.
- **A bar of a secondary series that changed at the source** and whose buckets straddle chunks let
  go is rebuilt once the neighbouring rows are back.
- **The memory limit is a target**: the window around the view, the first and last chunk of each
  series and the levels always stay.
- **Tick to applied on the main thread with 20 indicators** measured about 0.15 ms higher at p99 in
  most runs after the rebase (0.25–0.43 ms against 0.23–0.27 ms; gate 4 ms), with the engine's own
  time per tick unchanged. Not broken down.
- The refetch scenario's datafeed answers at once, in the page; a network adds its round trip to
  every latency here. Memory excludes canvas and GPU memory, as in stage 0.

## Reproducing

```sh
git worktree add ../lumen-main 591934d           # the code to compare against

# Refetch scenario
pnpm bench --case refetch --lib lumen-worker,lumen-main --repeats 2
pnpm bench --case refetch/line-10m/128mib/jumps,refetch/line-10m/1mib/jumps,refetch/line-10m/256mib/several \
  --lib lumen-worker,lumen-main --repeats 2 --packages ../lumen-main/packages

# Gate cases, before and after alternately; repeat the pair for each pass, then merge each side
pnpm bench --case tick/candles-1m,frames/line-10m/pan-all,frames/line-10m/zoom-all,frames/line-10m/pan-20k,frames/line-10m/zoom-20k,prepend,load/line-10m,load/candles-1m \
  --lib lumen-worker,lumen-main --repeats 1 --budget 3 --out benchmarks/results/after-1.json
pnpm bench:merge benchmarks/results/after.json benchmarks/results/after-1.json benchmarks/results/after-2.json

# The prepend outlier
pnpm bench --case prepend/candles-1m/1m --lib lumen-worker --repeats 5

# On top of stage 3: the cases the indicator integration could affect, alternately as above
git worktree add ../lumen-s3 cab3cc9
pnpm bench --case ind-apply/candles-1m,ind-prepend/candles-1m,tick/candles-1m --lib lumen-worker,lumen-main \
  --repeats 1 --budget 3 --packages ../lumen-s3/packages

pnpm bench:report docs/benchmarks/stage-2-follow-ups-refetch-after.json
```

The `ops` case needs `removeBars`, which `591934d` lacks, so it runs on the branch only. The Node
timings of prepends, of letting go and of ticks with indicators were one-off scripts outside the
repository. All benchmark runs for this document took 17 minutes of wall time (468 s for the first
round, 255 s for the second, 313 s on top of stage 3), plus about two minutes for the Node timings.

Unit tests that back the claims: `packages/engine/test/store.test.ts` (summaries, lookups across
chunks let go, removing rows), `packages/engine/test/memory.test.ts` (the floor, refetch checks,
cancelled requests, waiting corrections, deletions at the ends and in the middle, several series, a
new main timeline, letting go in slices), `packages/core/test/memory-cap.fuzz.test.ts` (several
series with and without datafeeds, corrections, deletions, failing, late, aborted and corrupt
answers and resolution changes against a model: never a wrong row, never a request left behind,
within the limit whenever more could go), `packages/core/test/window-cache.test.ts` and
`packages/core/test/chart.test.ts` (one-frame refetch, aborting on a moved view, a new history, a
removed series and destroy, resolution changes, corrections and deletions through the API).
