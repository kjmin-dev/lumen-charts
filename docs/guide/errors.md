# Errors

```ts
const unsubscribe = chart.subscribe('error', error => {
	switch (error.kind) {
		case 'refused':
			console.warn(`${error.count} updates of ${error.seriesId} refused`);
			break;
		case 'engine':
			log(error.message, error.cause);
			break;
		case 'worker':
			showReloadBanner(); // the chart keeps what it shows, and takes no more data
			break;
	}
});
```

The data engine works apart from the calls that hand it data: a call returns at once, and the
engine applies the data later, in a worker or in slices on the page's thread. What goes wrong there
does not throw from the call. It comes to `subscribe('error')` as a `ChartError` of one of three
kinds:

- **`engine`**: the engine threw while running a command. The command changes nothing the chart
  relies on, and the next commands run as usual. `message` is what was thrown. When the engine runs
  on the page's thread, `cause` is the value thrown, with its stack; from a worker only the message
  arrives.
- **`worker`**: the engine's worker failed after it had started: it fired an `error` event (an error
  it did not handle) or a `messageerror` event (a message from it could not be read). A command may
  never be answered then, so the worker is stopped. Every chart on that worker gets an error of its
  own, since charts can share a worker (see [several charts](several-charts.md)). `cause` is the
  event.
- **`refused`**: the engine did not apply `count` bars or points of the series `seriesId`: an update
  whose time falls between two bars or before the first, or a history whose times stop increasing.
  The refused bars are left out and the rest is applied.

Without a handler, `engine` and `worker` errors are reported as uncaught errors of the page (with
`reportError`), so they show in the console and in error tracking. `refused` ones are not reported
anywhere: a live feed that sends a late tick now and then is routine, and only an application that
asks hears about it. A handler that throws is reported the same way, and the other handlers still
run.

## After a worker error

The chart does not start another engine. The bars lived in the worker and are gone with it, and the
chart cannot fetch them back from its own calls. So the chart:

- keeps drawing the rows it holds, and goes on panning and zooming over them;
- takes no more data: `setData`, `update` and the other data calls do nothing, and
  `registerIndicators` rejects;
- keeps nobody waiting: `whenIdle()` and `whenApplied()` resolve, datafeed requests are aborted,
  and calls held back for data (`fitContent()` after `setData`, for example) run on what the chart
  holds.

To go on, destroy the chart and create a new one with its data. `saveState()` before destroying it
and `restoreState()` on the new chart keep its options, series, indicators, drawings and view.

A worker that fails while it starts is not an error: the chart falls back to the page's thread, as
it does when the page blocks workers, and no data is lost.
