import { type ChartApi, type ChartOptions, type DeepPartial, createChart } from '@lumen-ticks/core';
import { vi } from 'vitest';

export interface Call {
	name: string;
	args: unknown[];
	fillStyle: string;
	strokeStyle: string;
}

/** Stands in for a 2D context and records what is drawn. */
export function recorder(): { calls: Call[]; ctx: CanvasRenderingContext2D } {
	const calls: Call[] = [];
	const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', font: '10px sans-serif', lineWidth: 1 };
	const ctx = new Proxy(state, {
		get(target, property: string) {
			if (property === 'measureText') {
				return (text: string) => ({ width: text.length * 7 });
			}
			if (property in target) {
				return target[property];
			}
			return (...args: unknown[]) => {
				calls.push({
					name: property,
					args,
					fillStyle: String(target.fillStyle),
					strokeStyle: String(target.strokeStyle),
				});
			};
		},
		set(target, property: string, value) {
			target[property] = value;
			return true;
		},
	});
	return { calls, ctx: ctx as unknown as CanvasRenderingContext2D };
}

export const MINUTE = 60_000;

/** A chart of `count` one-minute candles on the main thread, with recording canvases. */
export class TestChart {
	public readonly chart: ChartApi;
	public readonly container: HTMLDivElement;
	public readonly recorders = new Map<HTMLCanvasElement, ReturnType<typeof recorder>>();
	public frames: ((now: number) => void)[] = [];
	public now = 0;
	public rectReads = 0;

	public constructor(options: DeepPartial<ChartOptions> = {}) {
		this.container = document.body.appendChild(document.createElement('div'));
		vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => this.frames.push(callback));
		vi.stubGlobal('cancelAnimationFrame', () => {});
		const recorders = this.recorders;
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
			this: HTMLCanvasElement,
			kind: string,
		) {
			if (kind !== '2d') return null;
			let entry = recorders.get(this);
			if (entry === undefined) {
				entry = recorder();
				recorders.set(this, entry);
			}
			return entry.ctx;
		} as unknown as HTMLCanvasElement['getContext']);
		this.chart = createChart(this.container, { autoSize: false, width: 640, height: 400, worker: false, ...options });
		vi.spyOn(this.chart.element(), 'getBoundingClientRect').mockImplementation(() => {
			this.rectReads++;
			return { left: 0, top: 0, width: 640, height: 400 } as DOMRect;
		});
	}

	public destroy(): void {
		this.chart.destroy();
		this.container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}

	/** Canvases in stacking order: pane, price axis, time axis, [drawings], overlay. */
	public canvases(): HTMLCanvasElement[] {
		return [...this.chart.element().querySelectorAll('canvas')];
	}

	public calls(canvas: HTMLCanvasElement | undefined): Call[] {
		return canvas === undefined ? [] : (this.recorders.get(canvas)?.calls ?? []);
	}

	public get pane(): Call[] {
		return this.calls(this.canvases()[0]);
	}

	/** The drawings layer, if the chart has one (it sits right below the overlay). */
	public get drawingsCanvas(): HTMLCanvasElement | undefined {
		const canvases = this.canvases();
		return canvases.length === 5 ? canvases[3] : undefined;
	}

	public get drawingsLayer(): Call[] {
		return this.calls(this.drawingsCanvas);
	}

	public get overlay(): Call[] {
		const canvases = this.canvases();
		return this.calls(canvases[canvases.length - 1]);
	}

	public clearCalls(): void {
		for (const entry of this.recorders.values()) {
			entry.calls.length = 0;
		}
	}

	public runFrames(): void {
		for (const frame of this.frames.splice(0)) {
			this.now += 16;
			frame(this.now);
		}
	}

	/** Runs frames and engine tasks until the chart reports that everything is applied and painted. */
	public async settle(): Promise<void> {
		const state = { done: false };
		void this.chart.whenIdle().then(() => {
			state.done = true;
		});
		for (let i = 0; i < 500 && !state.done; i++) {
			this.runFrames();
			// oxlint-disable-next-line no-await-in-loop
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		if (!state.done) {
			throw new Error('The chart did not settle');
		}
		this.runFrames();
	}

	public pointer(type: string, x: number, y: number, init: PointerEventInit = {}): void {
		this.chart
			.element()
			.dispatchEvent(
				new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', bubbles: true, ...init }),
			);
	}

	/** A press and release at one spot, each followed by a frame. */
	public click(x: number, y: number, init: PointerEventInit = {}): void {
		this.pointer('pointerdown', x, y, init);
		this.runFrames();
		this.pointer('pointerup', x, y, init);
		this.runFrames();
	}

	public key(key: string): void {
		this.chart.element().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	}
}

/** Column-major candles: bar `i` at `start + i` minutes, prices around 100. */
export function candles(count: number, start = 0) {
	const time = new Float64Array(count);
	const open = new Float64Array(count);
	const high = new Float64Array(count);
	const low = new Float64Array(count);
	const close = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		const base = 100 + Math.sin(i / 50) * 10;
		time[i] = (start + i) * MINUTE;
		open[i] = base;
		close[i] = base + (i % 2 === 0 ? 1 : -1);
		high[i] = base + 2;
		low[i] = base - 2;
	}
	return { time, open, high, low, close };
}
