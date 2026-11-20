---
'@lumen-charts/engine': patch
---

Fix a window request failing after the history was replaced (for example at another resolution)
while an indicator was still being computed in the background.
