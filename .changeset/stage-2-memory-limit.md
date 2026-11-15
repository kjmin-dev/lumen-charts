---
'@lumen-charts/core': minor
'@lumen-charts/engine': minor
---

Add a memory limit backed by a datafeed. `addSeries(type, { datafeed: { getBars } })` gives the
chart a source to fetch history from again, and the `memoryLimit` chart option lets the data
engine release bars far from the view past that many bytes and ask the datafeed for them when the
view returns. Levels of detail and bar times stay in memory, so zoomed-out views keep drawing and
fetched bars are checked against the released ones; mismatching bars are refused with a warning.
Without a datafeed nothing is released.
