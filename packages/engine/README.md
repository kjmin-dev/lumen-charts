# @lumen-ticks/engine

The data engine behind the chart: a chunked column store, levels of detail and the worker protocol. Applications use it through `@lumen-ticks/core` (or `lumen-ticks` and the framework bindings, which all re-export `./worker`, `configureWorker`, and `createWorkerPool`); install `@lumen-ticks/engine` directly only to use the engine standalone without the chart renderer.

Part of [Lumen Ticks](https://github.com/kjmin-dev/lumen-ticks), high-performance financial charts for the web.

```sh
npm install @lumen-ticks/engine
```

Usage, options and examples are in the [main README](https://github.com/kjmin-dev/lumen-ticks#readme).

## License

MIT
