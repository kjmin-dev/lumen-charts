---
'@lumen-charts/react': patch
---

The `LumenChart` ref now hands out the chart once it is created (it stayed `null`), and is set back to `null` on unmount. Options changed before the chart is created are no longer lost.
