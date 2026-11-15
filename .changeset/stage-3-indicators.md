---
'@lumen-charts/core': minor
'@lumen-charts/engine': minor
---

Add indicators computed in the data engine. `series.addIndicator(name, options)` (or
`chart.addIndicator(source, name, options)`) adds a built-in indicator (SMA, EMA, WMA, RSI, MACD,
Bollinger bands, ATR, Stochastic, VWAP, highest, lowest) or one registered from a plugin module with
`chart.registerIndicators(url)`; it returns a handle with `applyOptions`, `remove` and its outputs,
which can feed other indicators. Indicators are computed in full in the background after a load,
a parameter change or a prepend (the old values stay on screen until the new ones are ready) and
incrementally on every tick, in the same message as the bar. Their outputs are series on the main
timeline with levels of detail, drawn on the price pane and included in autoscale. Adds a histogram
series type, `chart.whenApplied()`, and the kernel contract (`IndicatorDefinition`,
`defineIndicator`, `computeIndicator`) to the engine package.
