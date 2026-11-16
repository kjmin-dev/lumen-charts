---
'@lumen-charts/core': patch
---

Redraw only what a tick changed. A frame drawn for new data alone, with the view, the price scales
and everything else on the series layer as they were, clears and redraws the device columns of the
changed bars instead of the whole layer, and leaves the layer alone when nothing in view changed.
The pixels are those of a full redraw. With 20 indicators over 1M bars in view this takes the
frame out of the time a tick needs to be applied. Charts with a custom series renderer, a `bottom`
primitive or drawings merged into the series layer keep the full redraw, as do frames in which a
price scale, the view or an option changes.

All layers are drawn again after the browser restores a lost canvas context.
