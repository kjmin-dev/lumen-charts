---
'@lumen-charts/core': patch
---

Speed up WebGL2 mark drawing: textures are found with shifts and masks, and a heatmap with both `valueMin` and `valueMax` set is drawn from one-byte palette slots, uploaded as columns come into view or change.
