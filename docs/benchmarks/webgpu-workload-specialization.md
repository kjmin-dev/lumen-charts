# WebGPU paths for dense scatter and heatmaps

Three changes merit different adoption rules on the Apple M1. Large square scatter markers benefit from collecting one winning point per center row before expanding it over neighboring rows. A fixed heatmap value range makes a one-byte palette index attractive. For trade-history pans, the profile points to CPU projection and uploads. These experiments use the chart at revision `69de92d`. The experimental implementations live in [the benchmark directory](../../benchmarks/prototypes/webgpu-specialization/). [Measurements for each run](webgpu-workload-specialization.json)

## Scatter by marker footprint

The shipping column shader selects the highest input ID covering each pixel, preserving the last point in input order even for tied timestamps. It performs one atomic maximum for each covered vertical pixel. The single-pass variant performs one atomic maximum per contributing point per output column, then takes the maximum of neighboring rows when writing the image. Eight extra workgroup words cover markers spanning a 1,024-row boundary. The two-pass variant also removes repeated horizontal scans. Its first dispatch produces vertical winner IDs per center column and its second expands them horizontally. Both dispatches are inside the measured pass. [Current WGSL shaders](../../packages/core/src/marks/gpu/shaders.ts) · [WGSL atomic operations](https://www.w3.org/TR/WGSL/#atomic-builtin-functions)

GPU pass p95 in milliseconds. One million source points, DPR 2, 1,200 × 600 CSS pixels. The uniform fixture showed approximately one million marks at level zero. The burst fixture placed 87.5% of points within the central 3.125% of the time range. Its viewport drew about 539,000 marks at level one. Each cell is the median of three within-run p95s over 48 alternating fractional viewport changes. The tested marker width is in **device pixels**.

| Marker width | Uniform, shipping | Uniform, single pass | Uniform, two passes | Burst, shipping | Burst, single pass | Burst, two passes |
| -----------: | ----------------: | -------------------: | ------------------: | --------------: | -----------------: | ----------------: |
|            1 |             0.983 |                0.983 |               1.442 |           0.917 |              1.049 |             0.852 |
|            3 |             1.507 |                1.638 |               2.818 |           1.114 |              1.376 |             1.442 |
|            5 |             3.015 |                2.032 |               3.211 |           1.704 |              1.638 |             1.770 |
|            7 |             5.505 |                2.490 |               2.687 |           3.473 |              1.966 |             2.884 |
|            9 |             5.571 |                3.211 |               3.146 |           4.522 |              2.425 |             3.211 |

- Trial the single-pass variant on full column-path draws at 7–9 pixels. All three paired 7- and 9-pixel runs improved in both distributions. The 5-pixel uniform case also improved in every pair. The 5-pixel burst difference is one timestamp increment on this device. The existing path remains appropriate for small markers and dirty strips. The tile path and the opaque append shortcut have their own selection criteria.
- The two-pass path adds a four-byte ID for every intermediate pixel. Switching the uniform fixture from one to three pixels increased its estimated renderer allocation from 27.47 to 37.39 MiB. The single-pass variant stayed at 27.47 MiB. The two-pass uniform 9-pixel p95 ranged from 2.49 to 4.65 ms across runs. The small median advantage there provides little justification for that buffer. The two-pass experiment routes 1-pixel draws through the shipping shader, illustrating the timing spread even for identical work.
- In the separate worker benchmark, a nominal three-million-point cloud drew about 736k LOD marks at the start of its zoom. The two-pass GPU p95 improved from 2.163 to 1.704 ms in that case, but worsened from 2.490 to 2.949 ms on the one-million-point raw cloud. Use the resolved path, footprint, visible marks and distribution when qualifying a selector.

## Heatmaps by update type

The prototype reuses the Canvas quantizer on the main thread. Each retained Float32 cell maps to a byte in a 256-entry color table. Four indices share one GPU storage word. The shader takes the largest slot among the source cells belonging to a pixel. The mapping is monotonic and zero represents missing data. The engine retains the source values for queries. Palette-only changes update the colors. A new window or a change in the numeric value mapping requantizes the corresponding data. The packed GPU representation saves three bytes per held cell and uses an additional one-byte-per-cell CPU staging array.

| 1.44M-cell worker viewport | Shipping GPU p95 | Packed GPU p95 | Shipping JS p95, timers off | Packed JS p95, timers off |
| -------------------------- | ---------------: | -------------: | --------------------------: | ------------------------: |
| Pan                        |         1.114 ms |       0.524 ms |                    1.175 ms |                  1.130 ms |
| Zoom                       |         1.311 ms |       0.721 ms |                    1.240 ms |                  1.190 ms |
| Replace last column        |         0.066 ms |       0.066 ms |                           — |                         — |

The pan and zoom runs held 2.88M source cells around a 1.44M-cell viewport. The renderer's estimated allocation fell from 30.84 to 22.61 MiB. The two uninstrumented paths both recorded a frame interval p95 of 16.67 ms on Chromium's virtual display. The advantage measured here is GPU time and resident GPU resources.

| 1.44M held cells, local-engine transition | Shipping JS p95 | Packed JS p95 | Queue writes per operation, shipping → packed |
| ----------------------------------------- | --------------: | ------------: | --------------------------------------------: |
| Change palette colors                     |        0.975 ms |      0.905 ms |                             29,408 → 29,408 B |
| Change numeric maximum                    |        0.815 ms |      4.780 ms |                          29,408 → 1,469,408 B |
| Replace 600-cell final column             |        0.615 ms |      0.590 ms |                                 2,432 → 632 B |

Trial packing when the numeric mapping stays fixed across viewport changes. Retain raw GPU scalars for frequently changing gain or log mapping. The range-change experiment exceeded the chart's 4 ms update-JS budget after packing. For a mixed workload, record the frequency of value-range invalidations and the cost of rebuilding the current window before introducing automatic switching. Recheck the dispatch thresholds on a mobile integrated GPU and a desktop discrete GPU.

## Trade-history pans and CPU projection

The reference always repacks and uploads the whole held scatter window when the vertical price projection changes. The third prototype tracks the contiguous interval of valid records. Its column shader needs only the visible interval including the marker footprint. Panning extends that interval at its edges. A patch also refreshes previously cached rows outside the viewport. Switching to tiles populates the full interval before building the price-band index. It preserves the shipping binary64 coordinate comparisons and row order.

| Worker chart, GPU timers off | Visible marks and LOD at start | Shipping frame JS p95 | Visible projection p95 |
| ---------------------------- | ------------------------------ | --------------------: | ---------------------: |
| Trade-shaped 5M case, pan    | 178,654 at level 3             |              6.290 ms |               4.105 ms |
| Uniform 1M case, zoom        | 1,001,315 at level 0           |              2.195 ms |               2.460 ms |

Three paired rounds used a two-second measurement budget. Each trade pan improved (7.525 → 4.105, 5.580 → 4.390, 6.290 → 4.000 ms). The raw zoom results overlapped. Both paths recorded frame interval p95 of 16.67 ms. In separate two-second main-thread profiles of the trade pan, sampled self time in `scatterRecords` fell from 55.7 to 24.3 ms. The trial still allocates buffers for the whole held window. It reduces the records projected on the CPU and written to the queue.

Prioritize this path for coarse trade-history pans with changing price projection and meaningful offscreen margins. Keep the raw cloud control in the acceptance suite. This experiment qualifies the workload direction; the minimum saved fraction of held rows needs calibration.

## Measurement scope

- Hardware Metal, Apple M1, headless Chromium 156. The worker benchmark uses candles and a drawing with the mark series. Each case ran three times per variant with a 1.5-second measurement budget and 30 warm-up frames. Path counters confirm WebGPU during the measurement window. Separate uninstrumented runs cover heatmap pan and zoom.
- A second production-built fixture isolates transitions using the local engine. It records public API time plus animation-callback JS, queue write bytes and the size of renderer-managed resources. The heatmap runs measure 30 operations after six warm-ups. The scatter runs alternate two neighboring viewports after eight warm-ups. First-use and marker-switch observations are in the JSON. Startup includes chart construction, fallback drawing, scheduling, device acquisition and pipeline compilation.
- GPU timestamps include commands within the compute pass. They exclude queue writes, 2D composition and physical presentation. Samples on this host fall on roughly 0.066 ms increments. Results near that increment and isolated differences between close medians do not establish a crossover. [WebGPU timestamp queries](https://www.w3.org/TR/webgpu/#timestamp)
- The combined prototype passed 123 Chromium chart-state comparisons across DPR 1, 1.5 and 2, and 82 WebKit comparisons across DPR 1 and 2. Each variant also passed nine dedicated full-chart RGBA comparisons against Canvas covering a tall pane, tied timestamps, transparent marks, 1-, 3-, 4- and 9-pixel squares, fractional zoom, inverted/log scales and an append. A separate check compared maximum packed slots against the shipping shader's threshold rule on 149,800 groups of float32 values across four mappings, including NaN, infinities and signed zeros. It found zero mismatches.

## Reproduce

Run from the repository root. Each patch applies to a fresh copy of the same packages.

```sh
research_dir=$(mktemp -d)
for variant in packed halo visible; do
  mkdir "$research_dir/$variant"
  git archive 69de92d packages | tar -x -C "$research_dir/$variant"
done
patches="$PWD/benchmarks/prototypes/webgpu-specialization"
git -C "$research_dir/packed" apply "$patches/packed-heat-two-pass-scatter.patch"
git -C "$research_dir/halo" apply "$patches/single-pass-halo.patch"
git -C "$research_dir/visible" apply "$patches/visible-scatter.patch"

node "$patches/transitions.mjs" --packages "$research_dir/packed/packages" --out /tmp/packed-transitions.json
node "$patches/transitions.mjs" --packages "$research_dir/halo/packages" --sizes 5,7 --out /tmp/halo-crossover.json
pnpm bench --packages "$research_dir/packed/packages" --lib lumen-worker --mark-renderer webgpu --case heatmap/candles-4800/2400x600/zoom --mark-gpu-timers --repeats 3 --budget 1.5
LUMEN_BENCH_PACKAGES="$research_dir/packed/packages" node benchmarks/runner/mark-charts.mjs --mode hardware --dpr 1,1.5,2
```

The CPU-projection comparison uses `--case scatter/candles-2k/trades-5m/pan,scatter/candles-2k/cloud-1m/zoom --budget 2` without GPU timers. Add `--profile /tmp/lumen-projection-trace` to a separate run to sample CPU stacks.

Omit `--packages` for the shipping baseline at the reference revision. Repeat both size lists on every prototype to recreate the footprint table. The JSON lists each worker case ID. Remove `--mark-gpu-timers` for the uninstrumented frame comparison.
