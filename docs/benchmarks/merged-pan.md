# Merged columns kept across a pan

Below a pixel per bar, `SeriesView.update` merges the rows of each pixel column into one item. A pan
used to merge every column again, for every series: 41% of a pan frame with 20 indicators and
20,000 bars in view before the min/max loops were made branch-free, and still the largest part of
such a frame after them ([stage 5 profile](stage-5-profile.md#where-a-frame-goes)). Since the
origin sits on a whole pixel there, a pan moves every column by whole pixels with the same rows in
it, and the view now keeps the columns it holds
([design](../design/stage-5.md#merged-columns-kept-across-a-pan)).

## Method

Apple M1 (8 cores, AC power), headless Chromium 156.0.8078.4, chart 1200 × 600 at DPR 2,
`lumen-worker`. Before is `main` at `69de92d` through `--packages`, after is this branch, with the
same harness. Three runs per case with a 3 s budget, two rounds in turns (before, after, before,
after). Frame JS is the median over runs of each run's p50 and p95.

A micro-benchmark of the view alone (Node 26, 25 series, 20,000 rows into 2,270 columns, pans of 1
to 8 pixels) gave 1.27 ms per frame before and 0.16 ms after at p50, with every item equal to a full
rebuild's in 400 frames.

## Results

Frame JS in ms; each cell gives round 1 / round 2.

| Case                                                      | p50 before    | p50 after     | p95 before  | p95 after     |
| --------------------------------------------------------- | ------------- | ------------- | ----------- | ------------- |
| `ind-frames/candles-1m/pan-20k`, 20 indicators            | 4.28 / 4.29   | 3.40 / 3.42   | 4.50 / 4.49 | 3.60 / 3.59   |
| `ind-frames/candles-1m/pan-200k`, 20 indicators           | 4.97 / 4.97   | 4.39 / 4.38   | 5.04 / 5.05 | 4.51 / 4.48   |
| `ind-frames/candles-1m/pan-all`, 20 indicators            | 4.05 / 4.00   | 3.52 / 3.46   | 5.22 / 5.28 | 4.52 / 4.50   |
| `frames/line-10m/pan-all`                                 | 0.685 / 0.680 | 0.655 / 0.660 | 1.00 / 0.99 | 0.925 / 0.925 |
| `ind-frames/candles-1m/zoom-all`, 20 indicators (control) | 4.23 / 4.24   | 4.24 / 4.24   | 5.37 / 5.36 | 5.40 / 5.40   |

- **Pans with indicators** take 0.5–0.9 ms less JavaScript per frame, 12–21% of it, in both
  rounds: the merging of the 25 outputs and the candles over the columns the view already held.
- **A zoom** changes the bar spacing and merges everything, as before: the control is unchanged.
- **What remains** of a wide pan frame is mostly line drawing (`drawLine`), which this does not
  touch.

Raw runs: [before](merged-pan-before.json), [after](merged-pan-after.json),
[before, round 2](merged-pan-before-2.json), [after, round 2](merged-pan-after-2.json).

## Reproduce

```sh
CASES=ind-frames/candles-1m/pan-20k,ind-frames/candles-1m/pan-200k,ind-frames/candles-1m/pan-all,ind-frames/candles-1m/zoom-all,frames/line-10m/pan-all
pnpm bench --case $CASES --lib lumen-worker --repeats 3 --budget 3 --packages <checkout of main>/packages --out before.json
pnpm bench --case $CASES --lib lumen-worker --repeats 3 --budget 3 --out after.json
```
