# Stage 2: level of detail and the memory limit, as built

What stage 2 built of the [design](../design.md). Each heading below is the section of the
design the text under it belongs to, and section numbers in the text are those of the design.
The measurements are in [docs/benchmarks/stage-2.md](../benchmarks/stage-2.md).

## 4.1 Chunked column store

- As built in stage 2: a dropped chunk keeps its time column (8 bytes per bar), so a refetch can be checked bar by bar against the global indexes it replaces and every time-to-index lookup keeps working; the levels of detail always stay. The cap applies to a series with a Datafeed while it is the only series with data.

## 4.2 LOD pyramid

- As built in stage 2: the main thread holds no raw bars for a wide view, so it has nothing to scan at the ends. Instead, a coarse level draws whole buckets only, each in the pixel column of its first bar, and the price range is exact for the bars drawn; they differ from the bars inside the pane by less than one bucket (under one device pixel) at either end. The origin snaps to a whole device pixel below one pixel per bar, so raw bars and buckets give the same pixels at every level switch.
