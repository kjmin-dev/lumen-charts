# @lumen-charts/engine

The data engine behind the chart: a chunked column store, levels of detail and the worker protocol. Applications use it through `@lumen-charts/core` (or `lumen-charts` and the framework bindings, which all re-export `./worker`, `configureWorker`, and `createWorkerPool`); install `@lumen-charts/engine` directly only to use the engine standalone without the chart renderer.

Part of [Lumen Charts](https://github.com/kjmin-dev/lumen-charts), high-performance financial charts for the web.

```sh
npm install @lumen-charts/engine
```

Usage, options and examples are in the [main README](https://github.com/kjmin-dev/lumen-charts#readme).

## License

MIT
