---
'@lumen-charts/core': patch
---

Add the `redraw` option: `auto` (default) redraws only the pixel columns a tick changed, as before;
`full` draws the whole series layer for every tick, for pages whose canvases are rasterized in
software, where a partial frame differs from a full redraw in a few antialiased pixels.

A tick no longer costs a dashed or dotted line its whole path. Such a line is drawn from the columns
that changed, after a lead as long as the path before them, so its dashes fall where those of the
whole path do, pixel for pixel.
