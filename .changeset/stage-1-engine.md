---
'@lumen-charts/core': minor
'@lumen-charts/engine': minor
---

Add candlestick and line series on an ordinal time scale. The data engine keeps history in a chunked
column store, runs in a worker (or time-sliced on the main thread when workers are blocked) and
feeds the chart through window snapshots and tick patches.
