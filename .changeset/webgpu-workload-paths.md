---
'@lumen-charts/core': patch
---

Speed up WebGPU mark drawing for three workloads. Square scatter markers of 5 to 9 device pixels drawn over the whole pane take one write per point instead of one per covered row. A change of the price projection projects and uploads the scatter rows in view, and those a pan brings into view, instead of every row held. A heatmap with both `valueMin` and `valueMax` set is drawn from one-byte palette slots, as with WebGL2. Fix heatmap slots that kept the old colors of a patched column after a frame drawn from the values, which a WebGL2 or Canvas 2D frame after a WebGPU one could show.
