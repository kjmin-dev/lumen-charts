---
'@lumen-charts/core': minor
'@lumen-charts/engine': minor
---

Add level of detail. The data engine keeps a pyramid of buckets (16, 64, 256, ... bars) for every
series, built in the background after a load and updated incrementally on prepends and ticks. Above
16 bars per device pixel the chart draws from the coarsest level whose buckets fit a pixel column,
so frame time no longer grows with the number of bars in view, and the main thread holds buckets
instead of raw rows for wide views. Switching between raw bars and a level draws the same pixels.
