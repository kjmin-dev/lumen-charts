---
'@lumen-charts/core': minor
---

Add chart events and coordinate conversions. `chart.subscribe('crosshairMove' | 'click', handler)` hands over a `ChartPointerEvent` with its source (pointer, keyboard or api), the point, the bar index and time, and the value of every series and indicator output there; events come at most once per frame, after it was drawn, and are built only while someone listens. `setCrosshairPosition(time, price, scaleId?)` and `clearCrosshairPosition()` place the crosshair for charts that sync it. The time scale gains `visibleLogicalRangeChange` and `visibleTimeRangeChange` events, `getVisibleRange` and `setVisibleRange` by time, and `timeToCoordinate`, `coordinateToTime`, `logicalToCoordinate` and `coordinateToLogical`.
