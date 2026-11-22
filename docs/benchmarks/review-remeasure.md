# The adversarial review's experiments, measured again

Design section 10 says that the review's experiments ran on a heavily loaded machine, that their direction holds and that their absolute numbers need re-measuring. The review left no scripts: the design arrived whole in the first commit (`f86ecc3`), and no file in the history holds an experiment of the review. Stage 5 notes that its own prototypes were also written outside the repository. This document re-measures the one claim with numbers that a short script can reproduce, the scan cost of chunked storage, and lists what it could not reproduce.

## Scan cost of the chunked store

The claim (design section 1.3): scanning chunked storage is 1.4 to 1.8 times slower than a contiguous buffer, negligible in absolute terms [review].

[`scan.ts`](../../benchmarks/prototypes/review-remeasure/scan.ts) fills the engine's own `ChunkedStore` (8,192 rows per chunk, six float64 columns) with 1M random-walk candles, and the same values into one contiguous `Float64Array` per column. It takes the highest high and the lowest low of a range three ways:

- **Chunk by chunk**: one loop over the rows of each chunk's column views, as the engine's loops read the store.
- **Row by row through the index**: `store.value(column, i)` for each row, a shift, a mask and two array lookups per value.
- **Contiguous**: one loop over the two plain columns.

The ranges are the whole series, and a 2,000-row view that crosses a chunk boundary. Each timed sample covers 10M rows (the view repeats 5,000 times), so a coarse browser timer stays under a tenth of a sample. Each case runs 20 passes, alternating which layout goes first, and keeps the median of the last 15. Every case compiles its own copies of the loops from their source, so the code a loop was optimized into over 1M rows does not serve the short view. [`scan-cost.mjs`](../../benchmarks/prototypes/review-remeasure/scan-cost.mjs) bundles the module with Vite and runs it in Node and in headless Chromium, WebKit and Firefox, one engine after another.

Apple M1, one engine after another, one-minute load average 14–18 (the machine ran other work throughout). Medians of 15 passes; the last column is one chunked scan of the range. [Raw results](review-scan-cost.json)

| Engine                       | Scan                                       | Chunked (ns/row) | Contiguous (ns/row) | Chunked / contiguous | One chunked scan |
| ---------------------------- | ------------------------------------------ | ---------------: | ------------------: | -------------------: | ---------------: |
| Node 26.13.1 (V8 14.6)       | whole series, chunk by chunk               |             1.29 |                1.23 |                 1.05 |          1.29 ms |
| Node 26.13.1 (V8 14.6)       | 2,000-row view, chunk by chunk             |             2.07 |                2.21 |                 0.94 |           4.1 µs |
| Node 26.13.1 (V8 14.6)       | whole series, row by row through the index |             4.82 |                1.55 |                 3.12 |          4.82 ms |
| Chromium 156 (V8)            | whole series, chunk by chunk               |             1.23 |                1.12 |                 1.10 |          1.23 ms |
| Chromium 156 (V8)            | 2,000-row view, chunk by chunk             |             2.18 |                2.39 |                 0.91 |           4.4 µs |
| Chromium 156 (V8)            | whole series, row by row through the index |             4.25 |                1.09 |                 3.90 |          4.25 ms |
| WebKit 27.2 (JavaScriptCore) | whole series, chunk by chunk               |             1.00 |                0.90 |                 1.11 |          1.00 ms |
| WebKit 27.2 (JavaScriptCore) | 2,000-row view, chunk by chunk             |             1.40 |                8.90 |                 0.16 |           2.8 µs |
| WebKit 27.2 (JavaScriptCore) | whole series, row by row through the index |             4.30 |                0.90 |                 4.78 |          4.30 ms |
| Firefox 157 (SpiderMonkey)   | whole series, chunk by chunk               |             1.90 |                2.10 |                 0.90 |          1.90 ms |
| Firefox 157 (SpiderMonkey)   | 2,000-row view, chunk by chunk             |             2.10 |                4.00 |                 0.52 |           4.2 µs |
| Firefox 157 (SpiderMonkey)   | whole series, row by row through the index |             9.50 |                2.30 |                 4.13 |          9.50 ms |

- **Chunk by chunk, the claim does not hold at its size.** Scanning the whole series costs 1.05–1.11 times the contiguous loop in V8 and JavaScriptCore, and 0.90 in SpiderMonkey: 1.0–1.9 ms per million rows, against 0.9–2.1 ms. The engine's own loops read the store this way (`chunkAt`, then the chunk's column views).
- **Row by row through the index, the cost is larger than claimed**: 3.1–4.8 times contiguous, 4.3–9.5 ms per million rows. `ChunkedStore.value` takes a shift, a mask, a chunk lookup and a column lookup per value. The engine uses it for single values (first and last time, binary searches), not for scans.
- **Negligible in absolute terms holds for a view.** A 2,000-row view costs 2.8–4.4 µs per scan chunk by chunk. Its ratios (0.16–0.94) are not a property of the layout: the same contiguous loop over 2,000 rows ran 1.8–9.9 times slower per row than over a million in each engine, and most in JavaScriptCore, so short scans measure each engine's loop entry and branch history more than memory layout.
- The review's 1.4–1.8 falls between the two access patterns; which one it measured is not recorded. An earlier version of this script (contiguous columns as views of one buffer, loops shared between cases), run under load averages of about 43, gave the same picture: chunk by chunk 0.78–1.13, through the index 2.05–4.22.

## What else could not be reproduced

| Claim in the design                                                                | Tag      | Status                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript and WASM results match bit for bit (section 5)                          | review   | Measured again in stage 5 with nine kernels over 1M rows: every output identical, NaN included ([stage 5 profile](stage-5-profile.md#wasm-kernels-reject-for-now)). That prototype is outside the repository too. |
| Zero-copy views over WASM memory hold only within one thread (section 1.2)         | review   | A property of the platform (a `WebAssembly.Memory` buffer cannot be transferred), not a measurement; not repeated.                                                                                                |
| The review failed to break the visual validity of aggregated candles (section 1.3) | review   | Settled by stage 2's level-switch checks (section 10).                                                                                                                                                            |
| Columnar `TypedArray` storage 2.8–4.7 times faster than arrays of objects          | measured | No script in the repository or its history.                                                                                                                                                                       |
| Work on 2,000 visible bars takes 0.7–2.6 µs                                        | measured | No script. The chunk-by-chunk view scan above is a comparable loop.                                                                                                                                               |
| Min/max over 1M values: 0.36 ms for f64, 0.17 ms for f32                           | measured | No script. Stage 5 timed other min/max loops on 1M rows (0.87–5.75 ns per row, by loop).                                                                                                                          |
| WASM runs at 0.97–1.5 times JavaScript; 11 Rust kernels compile to 5.1 KB          | measured | Stage 5 measured 0.95–1.24 times on its own kernels; its build was 62 KB because it linked Rust's standard library. The 5.1 KB build is not in the repository.                                                    |

## Reproduce

```sh
node benchmarks/prototypes/review-remeasure/scan-cost.mjs --out scan-cost.json
node benchmarks/prototypes/review-remeasure/scan-cost.mjs --engines node --rows 1000000
```
