# Main-thread allocation and tick latency

Two sources contributed to the old worker latency tail. Between ticks, the benchmark repeatedly created a promise and a message channel. With 20 indicators, a tick also delivered 243 individual patches to the client. Waiting in a sleeping worker leaves the main thread idle. Packing the patch index and column values into two buffers reduces the number of objects the receiver deserializes.

The three measurements below isolate the changes in order. Each profiled case ran for five seconds with 1M candles and 20 indicators. Allocation figures are sampled JavaScript heap bytes on the **main thread**, in decimal kB per applied tick. Each cell gives library / harness allocation. Native buffers and worker heap allocations are outside the sample. [All profiles, including call sites, both view sizes and runs without indicators](gc-floor-allocations.json).

| Engine and view    |    Original | Idle wait only | Idle wait + packed patches |
| ------------------ | ----------: | -------------: | -------------------------: |
| Worker, latest 200 | 45.3 / 30.2 |     45.1 / 0.6 |                  2.1 / 0.6 |
| Worker, all 1M     | 45.6 / 30.6 |     45.8 / 0.6 |                  2.2 / 0.7 |
| Main, latest 200   | 47.8 / 30.0 |     48.2 / 0.6 |                  3.8 / 0.6 |
| Main, all 1M       | 48.3 / 30.0 |     48.4 / 0.6 |                  3.9 / 0.7 |

In the latest-200 worker case, main-thread major collections fell from 25 (327 ms total) to 6 (6.4 ms) after changing the wait and to 5 (3.3 ms) after packing. The runs processed 3,488, 3,073 and 3,186 ticks respectively. The wait explains most of the latency floor. Packing primarily saves allocation. The no-indicator burst control allocated about 0.3–0.4 kB per submitted tick across both engines.

## Stage 3 gate

On Apple M1 in headless Chromium, the gate is p99 at most 4 ms from submitting a tick until its patches are applied, with 20 indicators and all 1M candles visible. Timings come from separate runs without heap sampling. [Individual timing runs](gc-floor-gate.json).

| View   | Engine       | Tick-to-applied p99 by run (ms) |
| ------ | ------------ | ------------------------------- |
| latest | lumen-worker | 0.695, 0.920, 0.455             |
| latest | lumen-main   | 0.500, 0.310, 0.255             |
| all    | lumen-worker | 0.665, 0.780, 0.975             |
| all    | lumen-main   | 0.430, 0.435, 0.595             |

All three wide-view worker runs met the desktop gate. Host load varied throughout the experiment.

Reproduce timing with `pnpm bench --case ind-apply/candles-1m --lib lumen-worker,lumen-main --repeats 3 --budget 3`. Add `--allocations benchmarks/results/allocations` to profile another run. Samples depend on V8, host load and scenario pacing. On a flagship Android phone the worker's p99 is 3.8–4.8 ms ([physical Android](android-physical.md#core-gates)).
