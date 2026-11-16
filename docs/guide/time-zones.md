# Time zones and sessions

```ts
const chart = createChart(element, {
	// An IANA name, `UTC` (default) or `local`; change it at any time with applyOptions.
	localization: { timeZone: 'America/New_York', locale: 'en-US' },
	sessions: {
		// When the market trades: plain JSON, saved and restored with the options.
		schedule: {
			timeZone: 'America/New_York', // the exchange's; empty takes the chart's
			days: [1, 2, 3, 4, 5],
			hours: [
				{ start: '04:00', end: '09:30', kind: 'pre' },
				{ start: '09:30', end: '16:00' },
				{ start: '16:00', end: '20:00', kind: 'post' },
			],
			holidays: ['2024-12-25'],
		},
		breaks: { visible: true }, // a line at the first bar of each trading day
	},
});

chart.timeScale().isInSession(bar.time); // extended hours included
chart.timeScale().sessionAt(bar.time); // { index: 1, kind: 'regular', tradingDay: '2024-06-03' } or null
```

Bar times stay UTC milliseconds, and the data engine never sees a time zone: only what is shown
changes. The time axis follows the wall clock of the zone. Day, month and year labels fall on its
midnights through daylight saving changes, hourly labels stay on the hour (half-hour and 45-minute
offsets included), and on a fine grid the hour repeated when the clocks go back is labeled again.
The crosshair's time label shows the same wall-clock time. Daily and longer bars (at least 20 hours
apart) are dates and keep their UTC date in every zone, as TradingView's datafeed convention stamps
daily bars at 00:00 UTC.

Converting a time is a lookup in a table of the zone's offset changes, not an `Intl` call. The table
is built when a zone is first shown, for the bars around the view, and grows as the view moves: `Intl`
is asked for the offset every two days and the change between two answers that differ is found to
the second. Tables are shared by the charts of a page. The first switch to a zone costs about a
millisecond for two years of bars, and the first zone of a page about 10 ms more, once, while `Intl`
loads its time zone data; later switches cost what any change of options costs (numbers in
[docs/benchmarks/stage-4-time-zones.md](../benchmarks/stage-4-time-zones.md)). Frames make no
`Intl` call.

A trading day is named by the date its sessions end, so a session from 18:00 to 17:00 (CME Globex)
belongs to the next day. With a schedule, days on the time axis are trading days, every session
start is a candidate for a label and the open of regular hours wins over the hours around it, and
extended hours are shaded (`sessions.extendedHours`). Breaks and shading are drawn while a day is at
least 6 CSS pixels wide. Without hours there is no schedule: the market never closes,
`isInSession` is always true and breaks, if turned on, mark calendar days. An unknown time zone or
locale, or a malformed schedule, throws a `RangeError` and changes nothing.

`localization.locale` takes month names, dates and the clock from a locale (each distinct label is
formatted once); `tickMarkFormatter(time, kind, wall)` and `timeFormatter(time, wall)` replace the
built-in labels, where `wall` is the wall-clock time to read with `getUTC*`.
