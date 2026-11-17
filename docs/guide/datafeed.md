# History on demand: datafeed and memory limit

```ts
const chart = createChart(element, { memoryLimit: 64 * 1024 * 1024 });
const candles = chart.addSeries('candlestick', {
	datafeed: {
		// Bars with times in [from, to] (UTC ms, inclusive): `countBack` of them, oldest first, in
		// any format setData accepts. `signal` is aborted once the bars are no longer needed.
		getBars: ({ from, to, signal }) => fetchBars(symbol, '1m', from, to, { signal }),
	},
});
candles.setData(history);
```

With a datafeed, the engine may let go of bars far from the view once it holds more than
`memoryLimit` bytes, and asks the datafeed for them when the view comes back. The levels of detail
stay in memory, so zoomed-out views keep drawing and the finest level is shown while bars are on
their way; bars fetched again are usually drawn in the frame after the view changed. A chunk of
8,192 bars let go keeps only a summary (its first and last time and checksums), against which the
bars that come back are checked: bars that differ in number or time are refused with a console
warning. Values may differ: a bar corrected at the source while it was let go comes back corrected.
A request whose bars the view no longer needs is aborted through `signal`; one that failed is tried
again after a pause that grows from 1 s to 30 s. The same bars are never requested twice at once.

The datafeed contract covers changes of history too:

```ts
// A correction of any existing bar, also one let go: it applies once that bar is back.
candles.update({ time: someOldTime, open, high, low, close });
// Bars removed at the source. At either end the other bars keep their indexes; in the middle the
// bars on the shorter side move over.
candles.removeBars({ from: firstRemovedTime, to: lastRemovedTime });
// Another resolution (or symbol), with a datafeed for it: requests for the old bars are aborted.
candles.setData(fiveMinuteHistory, { datafeed: fiveMinuteFeed });
```

The limit applies to every series with a datafeed; a series without one is never let go. While
other series are drawn on the main series' timeline it keeps the time of every bar, which merging
them takes. The limit is a target: the bars around the view, the first and last chunk of each series
and the levels always stay. The [design](../design.md) (section 8) explains the choices.

Indicator outputs are never let go and count toward the limit. An indicator recomputed over bars
that were let go (after a prepend, a parameter change, a correction or a deletion) fetches them
again from the datafeed, a window at a time. A correction recomputes the indicators that read the
series: in place with the tick when the bar is recent, in the background otherwise. A deletion
recomputes them in the background. Their old values stay on screen meanwhile, except after a
deletion in the middle of the main series, whose bars then have other indexes.
