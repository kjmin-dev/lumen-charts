---
'@lumen-charts/engine': minor
'@lumen-charts/core': minor
'lumen-charts': minor
'@lumen-charts/react': minor
'@lumen-charts/vue': minor
'@lumen-charts/svelte': minor
'@lumen-charts/solid': minor
---

Refine the worker declaration and pooling interface with zero hot-path overhead:

- **Polymorphic `WorkerSource` & `WorkerOption`**: `worker` now accepts URL strings, `URL` objects (normalized by absolute `href` so callers share a pool automatically), bundler worker constructors such as Vite `?worker` imports (invoked safely with `new` instead of silently falling back to the main thread), `'dedicated'` for an unshared worker per chart, explicit `WorkerPool` handles, and existing booleans or `() => Worker` factories.
- **Global configuration (`configureWorker` / `getWorkerConfig`)**: configure the default worker source, `maxWorkers`, and `timeout` once at app startup instead of threading worker factories through every chart.
- **Explicit `WorkerPool` (`createWorkerPool`)**: manage isolated bounded worker pools with `maxWorkers`, `activeWorkers`, `engines`, optional `warmup(count?)` pre-starting, and `destroy()` teardown.
- **Standalone `./worker` across every package**: `lumen-charts`, `@lumen-charts/core`, and all four framework bindings (`react`, `vue`, `svelte`, `solid`) now export a zero-import bundled `./worker` entry (with explicit `"sideEffects": ["./dist/worker.js"]`) and re-export the worker helpers directly.
- **Options handling**: `DeepPartial`, `mergeOptions`, and `optionsEqual` now preserve `URL`, constructor, and `WorkerPool` values intact instead of flattening non-plain objects.
