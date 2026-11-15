---
'@lumen-charts/core': minor
'lumen-charts': minor
---

Add multiple price axes. Besides the default price scale (`priceScale`, id `default`), a chart takes
any number of scales by id in `priceScales`: axes on the left or the right, several per side, or
overlays without an axis. Series and indicators choose theirs with `priceScaleId`, which can change at
any time. Each scale has a mode (`normal`, `logarithmic`, `percentage`, `indexed`, the last two
relative to each series' first visible bar), autoscale, margins and inversion. Series take a tick
size (`minMove`) and `precision` for their labels and the ticks of their axis; logarithmic axes tick
on round prices. Dragging an axis scales it and a double click resets it; the crosshair shows its
price on every visible axis and value labels go on the axis of each series. New API:
`chart.priceScale(id)`, `series.priceScale()`, `series.priceToCoordinate(price)` and
`series.coordinateToPrice(y)`, and the `PriceScaleApi`, `PriceScaleMode` and `PriceRange` types.
