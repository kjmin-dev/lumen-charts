---
'@lumen-charts/core': minor
'@lumen-charts/engine': minor
---

Report errors of the data engine instead of losing them. `chart.subscribe('error', handler)` receives a `ChartError`: `engine` when the engine threw while running a command (with the message, and the value thrown on the calling thread), `worker` when the engine's worker failed after it started, and `refused` with the series id and count of updates the engine did not apply. Without a handler, engine and worker errors are reported as uncaught errors of the page. A worker that fails after it started is stopped, and every chart on it settles `whenIdle` and `whenApplied`, runs the calls that waited for data and keeps drawing what it holds. Engine events carry `error`, `cause` and `rejectedSeries`, and `EngineClient.onlost` reports a lost worker.
