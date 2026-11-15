---
'@lumen-charts/core': minor
'@lumen-charts/react': minor
'@lumen-charts/vue': minor
'@lumen-charts/svelte': minor
'@lumen-charts/solid': minor
---

Add light and dark themes (plus `auto`, which follows the system color scheme) and display options:
grid line visibility and style, crosshair modes and line styles, price axis position, visibility,
border and margins, time axis visibility and border, and a watermark. Series gain `visible`, a
separate price line with its own color, width and style, candle outlines and optional wicks, and line
style, step lines and a crosshair marker. Chart options are now nested (`layout`, `grid`,
`crosshair`, `priceScale`, `timeScale`, `watermark`) and `applyOptions` merges them deeply; the
bindings take `DeepPartial<ChartOptions>`.
