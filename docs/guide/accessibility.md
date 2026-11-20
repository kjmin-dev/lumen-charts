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

| Action ID                      | Default keys               | Effect                                             |
| ------------------------------ | -------------------------- | -------------------------------------------------- |
| `previous` / `next`            | Left or Down / Right or Up | Inspect the previous or next sample.               |
| `pageBackward` / `pageForward` | Page Down / Page Up        | Move by the number of samples in the current view. |
| `first` / `last`               | Home / End                 | Inspect the first or last sample on the timeline.  |
| `zoomIn` / `zoomOut`           | Plus or equals / hyphen    | Zoom around the inspected position.                |
| `fitContent`                   | 0                          | Fit the timeline to the pane.                      |
| `refresh`                      | Enter                      | Refresh the selected values after live updates.    |

The navigator starts at the rightmost visible bar. Moving beyond the viewport scrolls the chart and requests its usual data window. At coarse levels of detail, each step visits an aggregate bucket. The reading identifies the covered bar numbers and the time the bucket starts. Zoom in to inspect its individual bars. A missing value is announced explicitly. A visible crosshair follows keyboard navigation when the chart's crosshair is enabled.

## Custom key bindings

Set `accessibility.keyBindings` in `createChart` or in a later `applyOptions` call. Each array lists alternative shortcuts for one action. Navigation actions keep their standard slider keys and accept extra shortcuts. For zoom, fit and refresh, the array replaces that action's shortcuts. An empty array disables a zoom, fit or refresh shortcut and clears any extra keys for a navigation action. Omitted actions keep their current settings.

```ts
chart.applyOptions({
	accessibility: {
		keyBindings: {
			previous: ['Shift+J'], // Shift+J or the standard arrows
			next: ['Shift+K'],
			fitContent: ['Ctrl+Shift+F', 'Cmd+Shift+F'],
			refresh: ['Option+[KeyR]'], // physical R position, on any layout
			zoomOut: [], // release the default minus shortcut
		},
	},
});
```

- Join modifiers and a key with `+`. Modifiers can appear in any order and must match exactly. Supported names are `Shift`, `Ctrl` (`Control`), `Alt` (`Option`) and `Meta` (`Cmd`, `Command`). Modifier names and ASCII letters are case-insensitive.
- Use the character produced by the keyboard layout or a named `KeyboardEvent.key` such as `ArrowRight` or `F8`. Use `Space` for the space bar and `Plus` for a literal plus sign. On a layout that produces `+` with Shift, the chord is `Shift+Plus`. The default zoom and fit bindings accept their characters with or without Shift.
- Use brackets for a physical `KeyboardEvent.code` such as `Shift+[Digit1]` or `Alt+[KeyR]`. This also works when Option produces a different character. The navigator leaves dead keys, text composition and browser-reported AltGr text input to the system. If a keystroke matches both a logical key and a physical key binding, the logical key takes precedence.
- Tab and Shift+Tab move focus out of the navigator. Assigning Tab, a modifier by itself or the same chord to two actions raises a `RangeError` before the chart applies the configuration. Browser and operating system shortcuts work as chart bindings only when the browser delivers their key events to the navigator.
- `chart.options().accessibility.keyBindings` lists the effective chords. The focused navigator and its screen reader description use the same bindings. Each chart keeps its own configuration across state restoration.

## Data exposed to assistive technology

The chart group has an accessible name and a summary of the timeline count, visible series, displayed times and the first visible price series' range. Its native slider supports both keyboard events and direct value adjustments from assistive technology. The canvas layers are hidden from the accessibility tree.

The navigator reports OHLC for candles and values for lines, histograms and indicator outputs. At aggregated detail, lines and histograms include their low, high and last value. Mark series contribute dataset counts at their current detail level. Prices are source values formatted with the series tick size and precision. Dates follow the chart's time zone and formatter. Built-in instructions are in English.

A polite status region announces the selected reading. Ticks at the same timestamp leave that snapshot in place until you refresh it. The passive range summary can update while focus is elsewhere. Host-supplied names and descriptions survive state restoration and can be changed with `applyOptions`.
