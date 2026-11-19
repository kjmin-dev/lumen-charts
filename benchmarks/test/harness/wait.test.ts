import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitIdle } from '../../src/harness/wait.ts';

/** A stand-in for the sleeping worker: answers after the milliseconds it is sent. */
class FakeSleeper {
	public static created = 0;
	public static slept: number[] = [];
	private _listener: (() => void) | null = null;

	public constructor() {
		FakeSleeper.created++;
	}

	public addEventListener(_type: string, listener: () => void): void {
		this._listener = listener;
	}

	public postMessage(duration: number): void {
		FakeSleeper.slept.push(duration);
		setTimeout(() => this._listener?.(), duration);
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('waitIdle', () => {
	it('resolves at once for no time at all', async () => {
		vi.stubGlobal('Worker', FakeSleeper);
		await waitIdle(0);
		await waitIdle(-1);
		await waitIdle(NaN);
		expect(FakeSleeper.created).toBe(0);
	});

	it('has one worker sleep for every wait, one wait at a time', async () => {
		vi.stubGlobal('Worker', FakeSleeper);
		vi.stubGlobal('URL', { createObjectURL: () => 'blob:sleeper', revokeObjectURL: () => undefined });
		const first = waitIdle(2);
		expect(() => waitIdle(1)).toThrow(/in progress/);
		await first;
		await waitIdle(1.5);
		expect(FakeSleeper.created).toBe(1);
		expect(FakeSleeper.slept).toEqual([2, 1.5]);
	});

	it('waits a task at a time where there is no shared memory', async () => {
		vi.stubGlobal('SharedArrayBuffer', undefined);
		const start = performance.now();
		await waitIdle(3);
		expect(performance.now() - start).toBeGreaterThanOrEqual(3);
		await waitIdle(1);
		expect(FakeSleeper.created).toBe(1);
	});
});
