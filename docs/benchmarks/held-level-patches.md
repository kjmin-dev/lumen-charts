# Patches of the levels a client holds

The chart names the levels its window cache holds with every window request, and the engine sends
patches of those levels only ([design](../design/stage-5.md#patches-of-the-levels-a-client-holds)).
This file compares tick cost before and after the change.

## Method

Headless Chromium, default viewport (1280x720), chart 1200x600 at device pixel ratio 2. Each case
runs three times with a 3 s budget. "Before" measures `main` at 69de92d through `--packages`,
"after" the branch `perf/held-level-patches`, with the same harness. Run the two one after the
other on an idle machine.

Patches per tick, counted by `packages/engine/test/held-levels.test.ts` with 20 indicators on
262,144 candles (the eight coarse levels of 1M), for an update of the last bar:

| Cache holds                      | Patches before | Patches after | Values before | Values after |
| -------------------------------- | -------------: | ------------: | ------------: | -----------: |
| every level (no mask)            |            243 |           235 |           879 |          871 |
| raw and level 1 (latest bars)    |            243 |            53 |           879 |          136 |
| raw and levels 2 to 4 (all bars) |            243 |           105 |           879 |          346 |

## Cases

- `ind-apply/candles-1m`, views `latest` and `all`, on `lumen-worker` and `lumen-main`: tick to
  applied patch with 20 indicators.
- `multi` on `lumen-worker` and `lumen-main`: several charts on one page and the cost of a round of
  ticks.

## Reproduce

```sh
# Before: a checkout of main at 69de92d
pnpm bench --case ind-apply/candles-1m,multi --lib lumen-worker,lumen-main --repeats 3 --budget 3 \
  --packages <checkout of main>/packages --out benchmarks/results/held-level-patches-before.json
# After: this branch
pnpm bench --case ind-apply/candles-1m,multi --lib lumen-worker,lumen-main --repeats 3 --budget 3 \
  --out benchmarks/results/held-level-patches-after.json
pnpm bench:report benchmarks/results/held-level-patches-after.json
```

## Results

Apple M1 (8 cores, AC power), headless Chromium 156.0.8078.4. Other work on the machine kept its
load average between 4 and 7, so the runs went in turns: before, after, before, after. Tick to
applied, median over three runs, in µs:

| Case                          | Engine       | Mean before | Mean after | p99 before | p99 after |
| ----------------------------- | ------------ | ----------: | ---------: | ---------: | --------: |
| `ind-apply/candles-1m/latest` | lumen-worker |   142 / 163 |  105 / 127 |  590 / 805 | 675 / 780 |
| `ind-apply/candles-1m/latest` | lumen-main   |   118 / 119 |    67 / 85 |  330 / 315 | 215 / 245 |
| `ind-apply/candles-1m/all`    | lumen-worker |   164 / 187 |  162 / 183 |  640 / 885 | 775 / 880 |
| `ind-apply/candles-1m/all`    | lumen-main   |   155 / 126 |  112 / 134 |  405 / 370 | 360 / 375 |

Each cell gives round 1 / round 2.

- **The latest bars**, the usual live view, gain in both rounds: the mean falls by about a third
  with the main-thread engine (118 → 67 and 119 → 85 µs), whose patch assembly is on the page's
  thread, and by about a fifth through the worker (142 → 105, 163 → 127 µs).
- **All bars in view** hold levels 2 to 4 and send 105 of 243 patches: the main-thread engine's
  mean fell in one round and not the other, and the worker's stayed where it was. The p99 of every
  case moves within the spread between rounds.
- **`multi`** (16 charts of 100k candles and 4 of 1M, no indicators: about 10 patches a tick)
  showed no change beyond the spread: per tick 16.2 / 21.5 µs before against 16.5 / 26.6 µs
  after for 16 worker charts, with the after round 2 run on a busier machine (its frames rose as
  well).

Raw runs: [before, round 1](held-level-patches-before-1.json), [after, round 1](held-level-patches-after-1.json),
[before, round 2](held-level-patches-before-2.json), [after, round 2](held-level-patches-after-2.json).
