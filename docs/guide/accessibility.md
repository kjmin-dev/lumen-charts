# Keyboard navigation and screen readers

Each chart has one keyboard stop for exploring its data. Tab to the chart to show the navigator and its current reading. Tab or Shift+Tab moves on to the next or previous control on the page. Mounting a chart and receiving data preserve the page's focus.

Give each chart a name that identifies its instrument and interval. The optional description can explain units or the data source. Series IDs identify individual readings.

```ts
const chart = createChart(container, {
	accessibility: { label: 'EUR/USD hourly', description: 'Prices in US dollars per euro.' },
	localization: { timeZone: 'Europe/Berlin', locale: 'de-DE' },
});
chart.addSeries('candlestick', { id: 'Bid', precision: 5 }).setData(bars);
```

## Controls

| Key                 | Action                                                                |
| ------------------- | --------------------------------------------------------------------- |
| Left or Down        | Inspect the previous sample.                                          |
| Right or Up         | Inspect the next sample.                                              |
| Page Down / Page Up | Move backward / forward by the number of samples in the current view. |
| Home / End          | Inspect the first / last sample on the timeline.                      |
| + or = / − (hyphen) | Zoom in / out around the inspected position.                          |
| 0                   | Fit the timeline to the pane.                                         |
| Enter               | Refresh the selected values after live updates.                       |

The navigator starts at the rightmost visible bar. Moving beyond the viewport scrolls the chart and requests its usual data window. At coarse levels of detail, each step visits an aggregate bucket. The reading identifies the covered bar numbers and the time the bucket starts. Zoom in to inspect its individual bars. A missing value is announced explicitly. A visible crosshair follows keyboard navigation when the chart's crosshair is enabled.

## Data exposed to assistive technology

The chart group has an accessible name and a summary of the timeline count, visible series, displayed times and the first visible price series' range. Its native slider supports both keyboard events and direct value adjustments from assistive technology. The canvas layers are hidden from the accessibility tree.

The navigator reports OHLC for candles and values for lines, histograms and indicator outputs. At aggregated detail, lines and histograms include their low, high and last value. Mark series contribute dataset counts at their current detail level. Prices are source values formatted with the series tick size and precision. Dates follow the chart's time zone and formatter. Built-in instructions are in English.

A polite status region announces the selected reading. Ticks at the same timestamp leave that snapshot in place until you refresh it. The passive range summary can update while focus is elsewhere. Host-supplied names and descriptions survive state restoration and can be changed with `applyOptions`.
