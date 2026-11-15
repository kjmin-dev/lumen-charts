import type { Job, MemorySample, PageRunResult } from '../jobs.ts';
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
		/** Present when Chromium runs with `--js-flags=--expose-gc`. */
		gc?: () => void;
	}
}
