---
'@lumen-charts/core': minor
'@lumen-charts/engine': minor
---

Add in-place mark corrections (`HeatmapSeriesApi.correct` and `ScatterSeriesApi.correct`), evict intermediate coarse mark LOD chunks under `memoryLimit` with on-demand materialization while keeping the topmost level resident, support a unified shared timeline across multiple mark series with `timeline` enabled, and render super-pixel coarse scatter LOD cells over the exact area their points cover across Canvas 2D, WebGL2, and `pointAt` hit testing.
