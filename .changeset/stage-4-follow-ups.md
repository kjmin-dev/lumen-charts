---
'@lumen-charts/core': patch
---

Close three limits of drawings and of save and restore.

Rectangles and price ranges have eight handles: the four corners and the middle of each edge.
Dragging one leaves the opposite corner or edge where it is. They are still two points in
`points()` and in the saved state, so states written before stay valid; a hit test answers
`1 + k` with `k` up to 7 for them.

Primitives and drawings can take part in autoscale. A pane primitive with an
`autoscale(range, view)` method is asked for the prices to keep in view in the frames that compute
price ranges, and a drawing takes part with the new `autoscale` option (default `false`): while
the time span of its points overlaps the pane, its price scale keeps it in view. The range is
joined with the series' range, the scale margins go around both, and a scale that does not
autoscale keeps its range. `AutoscaleRange` is exported.

`restoreState` matches drawings by id: a drawing whose state is what it is already is left alone
(no event), one that differs is updated in place with one `changed` event instead of a `removed`
and a `created`, and only the rest are added or removed. Indicators are matched by id as well: one
after the first difference is kept when its definition and source are the same and everything it
reads is kept; indicators a restore adds are listed after the ones it keeps.
