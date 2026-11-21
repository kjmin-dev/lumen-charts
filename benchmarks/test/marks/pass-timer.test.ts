import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMarkPassTimer } from '../../src/marks/pass-timer.ts';

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;

interface FakeQuery {
	id: number;
	nanoseconds: number;
}

/** The parts of a WebGL2 context the timer touches, recording the order of the calls. */
class FakeGl {
	public static extension: object | null = {};
	public readonly QUERY_RESULT_AVAILABLE = 1;
	public readonly QUERY_RESULT = 2;
	public readonly calls: string[] = [];
	public available = true;
	public disjoint = false;
	public deleted = 0;
	public next = 1;

	public getExtension(name: string): object | null {
		return name === 'EXT_disjoint_timer_query_webgl2' ? FakeGl.extension : null;
	}
	public getParameter(name: number): unknown {
		if (name !== GPU_DISJOINT_EXT) return null;
		const disjoint = this.disjoint;
		this.disjoint = false;
		return disjoint;
	}
	public createQuery(): FakeQuery {
		const id = this.next++;
		return { id, nanoseconds: id * 250_000 };
	}
	public beginQuery(target: number, query: FakeQuery): void {
		this.calls.push(target === TIME_ELAPSED_EXT ? `begin ${query.id}` : 'begin other');
	}
	public endQuery(target: number): void {
		this.calls.push(target === TIME_ELAPSED_EXT ? 'end' : 'end other');
	}
	public getQueryParameter(query: FakeQuery, name: number): unknown {
		return name === this.QUERY_RESULT_AVAILABLE ? this.available : query.nanoseconds;
	}
	public deleteQuery(): void {
		this.deleted++;
	}
	public clear(_mask: number): void {
		this.calls.push('clear');
	}
	public drawArrays(_mode: number, _first: number, _count: number): void {
		this.calls.push('draw');
	}
	public drawArraysInstanced(_mode: number, _first: number, _count: number, _instances: number): void {
		this.calls.push('draw instanced');
	}
}

function install(): { gl: FakeGl; timer: NonNullable<Window['markPassTimer']> } {
	// A class of its own per test: installing patches the prototype.
	class Context extends FakeGl {}
	vi.stubGlobal('WebGL2RenderingContext', Context);
	installMarkPassTimer();
	return { gl: new Context(), timer: window.markPassTimer! };
}

const STRIP = 5;

afterEach(() => {
	FakeGl.extension = {};
	vi.unstubAllGlobals();
});

describe('WebGL2 mark pass timer', () => {
	it('times the clear and draw of a paint between start and stop, in milliseconds', async () => {
		const { gl, timer } = install();
		gl.drawArrays(STRIP, 0, 4);
		timer.start();
		// A scatter paint: clear, then the instanced draw.
		gl.clear(1);
		gl.drawArraysInstanced(STRIP, 0, 4, 10);
		// A heatmap paint: the draw alone.
		gl.drawArrays(STRIP, 0, 4);
		timer.stop();
		gl.drawArrays(STRIP, 0, 4);
		expect(gl.calls).toEqual(['draw', 'begin 1', 'clear', 'draw instanced', 'end', 'begin 2', 'draw', 'end', 'draw']);
		expect(await timer.read()).toEqual([0.25, 0.5]);
		expect(gl.deleted).toBe(2);
	});

	it('ends a paint without a draw with its task', async () => {
		const { gl, timer } = install();
		timer.start();
		gl.clear(1);
		expect(gl.calls).toEqual(['begin 1', 'clear']);
		await Promise.resolve();
		expect(gl.calls).toEqual(['begin 1', 'clear', 'end']);
		gl.drawArrays(STRIP, 0, 4);
		timer.stop();
		expect(await timer.read()).toEqual([0.25, 0.5]);
	});

	it('waits frames for results, and discards those in flight at a disjoint event', async () => {
		const { gl, timer } = install();
		let frames = 0;
		vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
			frames++;
			if (frames === 2) gl.available = true;
			setTimeout(callback, 0);
		});
		timer.start();
		gl.drawArrays(STRIP, 0, 4);
		gl.drawArrays(STRIP, 0, 4);
		timer.stop();
		gl.available = false;
		expect(await timer.read()).toEqual([0.25, 0.5]);
		expect(frames).toBe(2);

		timer.start();
		gl.drawArrays(STRIP, 0, 4);
		timer.stop();
		gl.disjoint = true;
		expect(await timer.read()).toEqual([]);
		expect(gl.deleted).toBe(3);
	});

	it('measures nothing without the timer query extension', async () => {
		FakeGl.extension = null;
		const { gl, timer } = install();
		timer.start();
		gl.clear(1);
		gl.drawArrays(STRIP, 0, 4);
		timer.stop();
		expect(gl.calls).toEqual(['clear', 'draw']);
		expect(await timer.read()).toEqual([]);
	});
});
