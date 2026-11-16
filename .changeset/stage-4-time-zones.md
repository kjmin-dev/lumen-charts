---
'@lumen-charts/core': minor
---

Add time zones, locales and trading sessions to the chart. `localization.timeZone` (an IANA name,
`UTC` by default, or `local`) puts the time axis, its day, month and year boundaries and the
crosshair's time label on the zone's wall clock through daylight saving changes; it can change at
run time with `applyOptions`. Offsets come from a per-zone table built lazily from `Intl`, so
frames make no `Intl` call. `localization.locale`, `tickMarkFormatter` and `timeFormatter` format
the labels. `sessions.schedule` describes when the market trades (plain JSON: the exchange's zone,
weekdays, regular, pre- and post-market sessions, holidays); with it the axis counts trading days
and prefers session starts for labels, extended hours are shaded and `sessions.breaks` draws a line
at the first bar of each trading day. `timeScale().isInSession(time)` and `sessionAt(time)` answer
session queries. Bar times stay UTC milliseconds and the engine is unchanged.
