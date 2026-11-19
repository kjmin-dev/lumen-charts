---
'@lumen-charts/core': patch
'@lumen-charts/engine': patch
---

Reduce main-thread allocation when charts receive indicator updates. The chart requests packed buffers
for changed rows. Existing engine clients continue to receive arrays of patches by default.
