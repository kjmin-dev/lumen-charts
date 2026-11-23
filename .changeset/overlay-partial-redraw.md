---
'@lumen-charts/core': patch
---

Draw only what changed on the overlay. A frame compares the crosshair's lines, markers and labels, the handles of highlighted drawings and, after new data, the price lines and value labels with what it drew, and clears and redraws only the boxes of those that changed, with the pixels of a full redraw. Dashed lines in opaque colors are copied from a strip of their dashes instead of drawn dash by dash: a hover frame over 1,000 drawings makes about 17 Canvas 2D calls instead of about 470. Primitive layers skip their entries while no view changed, and a tick takes the price range of the items it rebuilt instead of every item of every series.
