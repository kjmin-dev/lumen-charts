# Background work right after a command

A worker host used to wait 20 ms after a command before it started background work (indicator
recomputations, levels of detail), so that the window request following a load could go first.
Stage 3 found that this wait was why a worker's 10k prepend took about 52 ms to show against 28 ms
on the main thread ([stage 3](stage-3.md#prepend)). The host now starts background work at once,
in slices of 1 ms for the 20 ms after a command and of 4 ms after that
([design](../design/stage-5.md#background-work-right-after-a-command)).

## Method

Apple M1 (8 cores, AC power), headless Chromium 156.0.8078.4, chart 1200 × 600 at DPR 2,
`lumen-worker`, 20 indicators. Before is `main` at `69de92d` through `--packages`, after is this
branch, with the same harness. Three runs per case with a 3 s budget, in turns: before, after, then
after, before. Other work on the machine kept its load average between 4 and 7.

## Results

Medians over three runs; each cell gives round 1 / round 2.

| Case                                        | Metric                   |   Before    |    After    |
| ------------------------------------------- | ------------------------ | :---------: | :---------: |
| `ind-prepend/candles-1m/10k`, 20k in view   | shown p50 (ms)           | 51.8 / 51.8 | 18.8 / 18.6 |
| `ind-prepend/candles-1m/10k`, 20k in view   | shown p95 (ms)           | 52.9 / 52.3 | 35.3 / 35.4 |
| `ind-prepend/candles-100k/10k`, 20k in view | shown p50 (ms)           | 51.9 / 52.0 | 35.1 / 34.9 |
| `ind-prepend/candles-1m/10k`, 20k in view   | first frame p50 (ms)     | 17.6 / 17.5 | 18.5 / 18.4 |
| `ind-prepend/candles-1m/1m`, 1M in view     | shown p50 (ms)           |  377 / 410  |  360 / 360  |
| `ind-load/candles-1m`                       | settled (ms)             |  316 / 316  |  283 / 283  |
| `ind-load/candles-1m`                       | first frame (ms)         | 16.7 / 16.4 | 16.1 / 16.3 |
| `ind-apply/candles-1m/latest`               | tick to applied p99 (ms) | 1.36 / 1.38 | 1.30 / 1.32 |
| `ind-apply/candles-1m/all`                  | tick to applied p99 (ms) | 1.32 / 1.32 | 1.41 / 1.36 |

- **A 10k prepend** shows its recomputed indicators 33 ms sooner with 1M bars and 17 ms sooner with
  100k: the 20 ms the worker sat idle, and the slices it then gave the recomputation. The p95 of the
  1M case is the run whose indicators needed another frame.
- **A load** settles 33 ms sooner (316 → 283 ms), and a 1M prepend 17–50 ms sooner.
- **The bars of a prepend** reach the screen about 0.8 ms later (first frame 17.6 → 18.4 ms): the
  window request that follows the prepend now waits for the 1 ms slice under way, where it found the
  worker idle before. This is the cost the old delay avoided; a 4 ms slice would have made it up to
  4 ms.
- **Ticks** are unchanged: with no recomputation under way there is no background work for them to
  wait for.

Raw runs: [before](background-start-before.json), [after](background-start-after.json),
[after, round 2](background-start-after-2.json), [before, round 2](background-start-before-2.json).

## Reproduce

```sh
CASES=ind-prepend/candles-1m/10k,ind-prepend/candles-100k/10k,ind-prepend/candles-1m/1m,ind-load/candles-1m,ind-apply/candles-1m
pnpm bench --case $CASES --lib lumen-worker --repeats 3 --budget 3 --packages <checkout of main>/packages --out before.json
pnpm bench --case $CASES --lib lumen-worker --repeats 3 --budget 3 --out after.json
```
