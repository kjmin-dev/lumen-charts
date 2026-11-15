---
'@lumen-charts/core': minor
'@lumen-charts/engine': minor
---

Add drawings, pane primitives and custom series renderers. `chart.drawings()` adds, lists, edits
and removes drawings (trend line, ray, extended line, horizontal and vertical line, rectangle,
parallel channel, Fibonacci retracement, text, price range) with style options, z-order and
visible and locked flags; `startTool(type)` lets the user create one with the pointer, and hovering,
selecting, dragging a drawing or one of its points, Escape, Delete and the magnet crosshair work as
in trading terminals, with a wider hit tolerance for touch. Points are stored as times and prices,
so drawings keep their place through prepends, deletions and changes of resolution; times between
bars and in the future are placed between bars and at the spacing of the last bars. Events
(`created`, `changed`, `removed`, `selected`, `hovered`) and a plain-JSON state per drawing
(`toJSON`, with a version) come with them. Drawings have a canvas layer of their own, so hovering
redraws only the overlay and dragging one drawing redraws no other; near a page-wide canvas budget
(`setCanvasBudget`) they move into the series layer. `chart.attachPrimitive` and
`series.attachPrimitive` take user code that draws below the series, with the drawings or on the
overlay, with the chart's coordinate conversions and hit testing; `series.setRenderer` and
`indicator.output().setRenderer` draw a series or an indicator output with user code. The engine
gains a `resolve` command that maps times to logical positions on the main timeline.
