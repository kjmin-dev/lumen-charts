# Price axis follow-ups

Value labels that keep apart, scales that go once nothing is on them, a magnet that measures every
series on screen, and the wheel and pinch on an axis
([design](../design/stage-4-price-axes.md#81-as-built-in-stage-4-price-axes)). What they add to a
frame: every frame that updates the model marks the scales in use (a pass over the series, heatmaps
and scatters and primitives, with a counter, allocating nothing), and every overlay frame places the
value labels of each axis (an insertion sort of the labels shown and one pool-adjacent-violators
pass, in reused arrays). This file checks that frames take as long as before.

## Method

Headless Chromium, default viewport (1280x720), chart 1200x600 at device pixel ratio 2,
`lumen-worker`, one run per case with a 1.5 s budget. "Before" measures `main` at 9ee1ef4 through
`--packages` (a temporary checkout, removed afterwards), "after" this branch at 1e59260, with the
same harness. Each run serves its own build on a port of its own; the results record the sources
measured (`environment.sources`: the checkout of main, or `workspace`) and the commit of the harness.

Other agents ran benchmarks on the machine at the same time, so the runs went in turns, before then
after, and record the load average at their start and end. Rounds 1 to 3 ran every case; rounds 4
to 7 and 8 to 11 ran again the cases whose first rounds leaned one way.

## Cases

- `frames/candles-1m`: pan and zoom frames over 1M candles at five zoom levels: one series, one
  value label, no magnet.
- `axes-frames/candles-1m/pan-200`, layouts `one` (candles and three moving averages on one scale:
  four value labels spread on one axis) and `four` (each average on an axis of its own, listed in
  `priceScales`: four scales marked in use every frame).
- `drawings/candles-1m/1000/hover`: a mouse hovering over 1,000 drawings, which redraws the
  overlay (value label, crosshair and its labels) in every frame.

## Reproduce

```sh
# Before: a checkout of main at 9ee1ef4
pnpm bench --lib lumen-worker --repeats 1 --budget 1.5 \
  --case frames/candles-1m,drawings/candles-1m/1000/hover,axes-frames/candles-1m/pan-200/one,axes-frames/candles-1m/pan-200/four \
  --packages <checkout of main>/packages --out benchmarks/results/price-axis-follow-ups-before-1.json
# After: this branch
pnpm bench --lib lumen-worker --repeats 1 --budget 1.5 \
  --case frames/candles-1m,drawings/candles-1m/1000/hover,axes-frames/candles-1m/pan-200/one,axes-frames/candles-1m/pan-200/four \
  --out benchmarks/results/price-axis-follow-ups-after-1.json
```

## Results

Apple M1 (8 cores, AC power), headless Chromium 156.0.8078.4. Load averages (start–end of a run):
14 to 23 in rounds 1 to 3, 6 to 12 in rounds 4 to 11. Frame JavaScript time, p50 of each run, in
µs; the median and the range are over the rounds listed, and the last column counts the rounds in
which the after run was slower / faster than the before run just ahead of it.

| Case                                  | Rounds    | Median before | Median after | Range before | Range after | p95 before | p95 after | Slower / faster |
| ------------------------------------- | --------- | ------------: | -----------: | -----------: | ----------: | ---------: | --------: | --------------: |
| `frames/candles-1m/pan-200`           | 1–3       |           230 |          240 |      220–250 |     230–245 |        285 |       300 |           2 / 1 |
| `frames/candles-1m/zoom-200`          | 1–3       |           235 |          225 |      230–240 |     220–235 |        295 |       295 |           1 / 2 |
| `frames/candles-1m/pan-2k`            | 1–3       |           365 |          360 |      360–380 |     360–370 |        415 |       420 |           1 / 1 |
| `frames/candles-1m/zoom-2k`           | 1–3       |           395 |          405 |      395–400 |     395–420 |        465 |       475 |           2 / 0 |
| `frames/candles-1m/pan-20k`           | 1–7       |           435 |          440 |      410–685 |     430–685 |        530 |       550 |           4 / 3 |
| `frames/candles-1m/zoom-20k`          | 1–3       |           455 |          465 |      450–460 |     440–475 |        535 |       585 |           2 / 1 |
| `frames/candles-1m/pan-200k`          | 1–3, 8–11 |           430 |          450 |      400–615 |     425–540 |        520 |       545 |           4 / 3 |
| `frames/candles-1m/zoom-200k`         | 1–3, 8–11 |           440 |          430 |      400–770 |     410–755 |        655 |       510 |           5 / 2 |
| `frames/candles-1m/pan-all`           | 1–3       |           355 |          365 |      335–360 |     340–370 |        425 |       430 |           3 / 0 |
| `frames/candles-1m/zoom-all`          | 1–3, 8–11 |           435 |          345 |      320–620 |     330–620 |        660 |       385 |           5 / 2 |
| `axes-frames/candles-1m/pan-200/one`  | 1–3, 8–11 |           305 |          295 |      260–405 |     275–380 |        515 |       340 |           3 / 4 |
| `axes-frames/candles-1m/pan-200/four` | 1–7       |           315 |          315 |      280–330 |     285–385 |        425 |       390 |           4 / 3 |
| `drawings/candles-1m/1000/hover`      | 1–7       |           215 |          225 |      185–310 |     215–250 |        325 |       295 |           4 / 3 |

- **No change in frame time can be told apart from the noise.** Medians move by -90 to +20 µs and
  every after range overlaps its before range. In rounds 1 to 3 (load 14 to 23) the after runs of
  eight of the ten `frames` cases were slower in two or three rounds of three, by 5 to 45 µs (1 to
  10%); the four of them run again in rounds 4 to 11, at load 6 to 12, went both ways, by up to
  ±300 µs. A cost of a few percent can therefore not be excluded at these loads, nor confirmed.
- **The hover frames**, which draw the overlay and its labels in every frame but update no model,
  were 15 to 50 µs slower after in rounds 1 to 3; in rounds 4 to 7 the after runs were 60 and 85 µs
  faster in two rounds, as fast in one and 15 µs slower in one. Nothing in such a frame got more
  work than placing one value label.
- **Four labels on one axis** (`one`) and **four scales in use** (`four`) cost what they cost
  before, within the same spread.

Raw runs, round by round: before [1](price-axis-follow-ups-before-1.json),
[2](price-axis-follow-ups-before-2.json), [3](price-axis-follow-ups-before-3.json),
[4](price-axis-follow-ups-before-4.json), [5](price-axis-follow-ups-before-5.json),
[6](price-axis-follow-ups-before-6.json), [7](price-axis-follow-ups-before-7.json),
[8](price-axis-follow-ups-before-8.json), [9](price-axis-follow-ups-before-9.json),
[10](price-axis-follow-ups-before-10.json), [11](price-axis-follow-ups-before-11.json); after
[1](price-axis-follow-ups-after-1.json), [2](price-axis-follow-ups-after-2.json),
[3](price-axis-follow-ups-after-3.json), [4](price-axis-follow-ups-after-4.json),
[5](price-axis-follow-ups-after-5.json), [6](price-axis-follow-ups-after-6.json),
[7](price-axis-follow-ups-after-7.json), [8](price-axis-follow-ups-after-8.json),
[9](price-axis-follow-ups-after-9.json), [10](price-axis-follow-ups-after-10.json),
[11](price-axis-follow-ups-after-11.json).
