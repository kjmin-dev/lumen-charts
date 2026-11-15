import type { Job, MainThreadTimes, MemorySample, PageRunResult } from '../jobs.ts';
import type { PageEnvironment } from './environment.ts';

/** What the harness page exposes as `window.bench` for the runner. */
export interface BenchApi {
	environment(): Promise<PageEnvironment>;
	run(job: Job): Promise<PageRunResult>;
}

declare global {
	interface Window {
		bench?: BenchApi;
		/** Installed by the runner (CDP `HeapProfiler.collectGarbage`). */
		__benchCollectGarbage?: () => Promise<void>;
		/** Installed by the runner (CDP `Runtime.getHeapUsage`). */
		__benchMeasureMemory?: () => Promise<MemorySample>;
		/** Installed by the runner (CDP `Performance.getMetrics`): main-thread time since the page started. */
		__benchMainThread?: () => Promise<MainThreadTimes>;
		/** Installed by the runner (`ps` on the renderer processes): their resident memory in bytes. */
		__benchRendererMemory?: () => Promise<number | null>;
		/** Present when Chromium runs with `--js-flags=--expose-gc`. */
		gc?: () => void;
	}
}
