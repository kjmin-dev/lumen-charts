---
'@lumen-charts/core': patch
'@lumen-charts/engine': patch
---

Make ticks cheaper on long histories. A chart names the levels of detail it holds with each window
request, and the engine sends changed buckets of those levels only, instead of every level. A tick
that adds no bar no longer sends the bucket times of coarse levels, which it cannot change.
`EngineClient.requestWindow` takes the levels as an optional bitmask; clients that do not pass it
receive every level as before.
