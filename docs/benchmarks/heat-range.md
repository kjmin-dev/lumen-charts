# Heatmap color-range changes and WebGPU presentation

This study isolates what changes in each frame of the 2,400 × 600-cell heatmap. All cases pan by the same whole-pixel offsets over the same resident 8-bit values. One case keeps the value-to-color mapping fixed. The other changes its gain on every frame, as when adjusting the displayed intensity range. For an input byte v the color index is min(255, floor(v × gain / 256)). Fixed gain is 256. Variable gain changes every frame while the data, viewport positions and color ramp stay identical between paths. Output size is 2,400 × 1,200 device pixels. Each backend renders identical pixels at initialization and at 16 consecutive positions for each case.

- Canvas 2D caches a precolored bitmap. A range change rebuilds a 256-color lookup table, remaps the 1.44M scalar values and calls `putImageData` once before drawing the bitmap.
- WebGL2 and WebGPU keep an R8 texture and evaluate the color in their fragment shaders. A range change updates a scalar alongside the view transform. The original composition path draws the result into a visible 2D canvas.
- The direct WebGPU variant presents its canvas as the only visible layer. It measures how much the extra 2D composition costs in this fixture. The bundle variant also records the pipeline, bind group and single draw at setup and replays that bundle in each render pass. Both direct variants use the same texture and shaders as the composited GPU path. [WebGPU render bundles](https://www.w3.org/TR/webgpu/#render-bundles).

The table reports the median of five per-run p95s for JS and compositor intervals and four per-run p95s for GPU timestamps. Each run warms up for 12 frames and samples 60. The runner rotates the order of the paths. JS includes updates and draw submission. GPU timestamps span the draw pass. Units are milliseconds.

| Layer                  | Fixed JS | Changing JS | Fixed GPU | Changing GPU | Fixed display interval | Changing display interval |
| ---------------------- | -------: | ----------: | --------: | -----------: | ---------------------: | ------------------------: |
| Canvas 2D              |    0.120 |       3.400 |         — |            — |                 17.637 |                    18.476 |
| WebGL2                 |    0.095 |       0.120 |     0.934 |        0.898 |                 17.625 |                    17.748 |
| WebGPU                 |    0.150 |       0.160 |     0.393 |        0.393 |                 17.854 |                    17.536 |
| WebGPU direct          |    0.145 |       0.130 |     0.393 |        0.393 |                 17.551 |                    17.521 |
| WebGPU direct + bundle |    0.145 |       0.130 |     0.492 |        0.393 |                 17.713 |                    17.430 |

The one-minute system load average went from 163.8 to 217.9 in the frame runs and from 234.4 to 166.9 in the GPU runs. Small differences in submission or presentation time are sensitive to this background load.

Changing the color range increased the Canvas 2D JS p95 from 0.12 to 3.40 ms. Both texture renderers kept the scalar data on the GPU. With changing gain, removing the intermediate WebGPU-to-2D composition reduced median JS p95 from 0.16 to 0.13 ms. Replaying the single draw in a bundle also measured 0.13 ms. This single-draw workload provides little evidence about the benefit of bundles for many layers or draws.

This is an isolated mark-layer comparison on an M1 through headless Chromium. The display interval comes from Chromium compositor events. It cannot establish physical scanout or the composition cost of a complete chart with interleaved heatmap, price and drawing layers. All backends receive the same pixel-aligned pan. The earlier affine zoom fixture matched at its original checkpoints but differed at some additional fractional zoom positions when checked over 16 frames. Equivalence over every fractional zoom remains open.

```sh
node benchmarks/runner/mark-backends.mjs --heat-paths --repeats 5 --out /tmp/heat-range-frames.json
node benchmarks/runner/mark-backends.mjs --heat-paths --gpu-timers --repeats 4 --out /tmp/heat-range-gpu.json
```

[Frame measurements](heat-range-frames.json) · [GPU timestamp measurements](heat-range-gpu.json) · [Dense scatter comparison](scatter-paths.md)
