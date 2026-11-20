# Patches of the levels a client holds

The chart names the levels its window cache holds with every window request, and the engine sends
patches of those levels only ([design](../design/stage-5.md#patches-of-the-levels-a-client-holds)).
This file compares tick cost before and after the change. The numbers are not measured yet.

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

TODO: fill in from the runs above.

| Case                          | Engine       | Before p99 (ms) | After p99 (ms) | Before mean (ms) | After mean (ms) |
| ----------------------------- | ------------ | --------------: | -------------: | ---------------: | --------------: |
| `ind-apply/candles-1m/latest` | lumen-worker |            TODO |           TODO |             TODO |            TODO |
| `ind-apply/candles-1m/latest` | lumen-main   |            TODO |           TODO |             TODO |            TODO |
| `ind-apply/candles-1m/all`    | lumen-worker |            TODO |           TODO |             TODO |            TODO |
| `ind-apply/candles-1m/all`    | lumen-main   |            TODO |           TODO |             TODO |            TODO |
| `multi`, round of ticks       | lumen-worker |            TODO |           TODO |             TODO |            TODO |
| `multi`, round of ticks       | lumen-main   |            TODO |           TODO |             TODO |            TODO |
