---
'@lumen-charts/core': minor
---

Select Canvas 2D, WebGL2 or WebGPU per chart for scatter and heatmap series. WebGL2 is the default and the preferred fallback for WebGPU. Canvas 2D handles environments without either GPU API. The former `auto` setting resolves to WebGL2.
