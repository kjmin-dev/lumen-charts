import { canvas2d } from './canvas2d.js';
import { webgl2 } from './webgl2.js';
import { webgpu } from './webgpu.js';
import { webgpuColumns } from './webgpu-columns.js';
import { canvas, height, makeScene, updateScene, viewFor, width } from './scene.js';

// Both graphics APIs get the same visible-range control. The half-open interval selects
// precisely the centers kept by the reference shader, including the original draw-order IDs.
function visibleRange(renderer) {
	return async (target, scene, timer) => {
		const draw = await renderer(target, scene, timer);
		const lowerBound = (pixel, scale, lo, hi) => {
			while (lo < hi) {
				const mid = lo + Math.floor((hi - lo) / 2);
				if (Math.floor(scene.points[2 * mid] * scale) < pixel) lo = mid + 1;
				else hi = mid;
			}
			return lo;
		};
		return (v, first, count, update) => {
			if (update) return draw(v, first, count, true);
			const x = v.x + v.shift;
			const end = first + count;
			const left = lowerBound(x, v.scale, first, end);
			const right = lowerBound(x + v.w, v.scale, left, end);
			draw(v, left, right - left, false);
		};
	};
}

const backends = {
	canvas2d,
	webgl2,
	webgpu,
	webgl2Visible: visibleRange(webgl2),
	webgpuVisible: visibleRange(webgpu),
	webgpuColumns,
};
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

async function digest(ctx) {
	const data = ctx.getImageData(0, 0, width, height).data;
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
	return Array.from(hash, n => n.toString(16).padStart(2, '0')).join('');
}

export async function run({ backend, type, count, action, frames, check, gpuTimers, shape, checkSequence }) {
	const warmup = 12;
	const scene = makeScene(type, count, Math.max(16, warmup + frames + 1), shape);
	const output = canvas(width, height);
	output.style.width = width / devicePixelRatio + 'px';
	output.style.height = height / devicePixelRatio + 'px';
	document.body.replaceChildren(output);
	const screen = output.getContext('2d');
	const target = canvas(width, height);
	const initStart = performance.now();
	const timer = gpuTimers ? { frames, index: -1 } : null;
	const draw = await backends[backend](target, scene, timer);
	const initial = viewFor('pan', 0, scene);
	draw(initial, 0, count, false);
	screen.drawImage(target, 0, 0);
	const setupMs = performance.now() - initStart;
	// All backends compose into the same visible 2D canvas. A tick touches only its dirty rectangle.
	if (action === 'tick') {
		const v = viewFor(action, 0, scene);
		target.width = v.w;
		target.height = v.h;
	}
	function render(frame) {
		const update = action === 'tick';
		if (update) updateScene(scene, frame);
		const v = viewFor(action, frame, scene);
		draw(v, update ? count + frame : 0, update ? 1 : count, update);
		if (!update) screen.clearRect(0, 0, width, height);
		screen.drawImage(target, v.x, v.y);
	}
	if (check) {
		const before = await digest(screen);
		if (checkSequence) {
			const sequence = [];
			for (let i = 0; i < 16; i++) {
				render(i);
				sequence.push(await digest(screen));
			}
			if (new Set(sequence).size < 2) throw new Error('Rendered frames did not change');
			return { before, sequence };
		}
		render(1);
		const middle = await digest(screen);
		render(8);
		const after = await digest(screen);
		if (before === after) throw new Error('Rendered frame did not change');
		return { before, middle, after };
	}
	const js = [];
	const stamps = [];
	for (let frame = 0; frame < warmup + frames; frame++) {
		const stamp = await nextFrame();
		if (frame === warmup) performance.mark('marks:start');
		if (timer) timer.index = frame - warmup;
		const start = performance.now();
		render(frame);
		if (frame >= warmup) {
			js.push(performance.now() - start);
			stamps.push(stamp);
		}
	}
	stamps.push(await nextFrame());
	performance.mark('marks:end');
	return { js, stamps, setupMs, gpuPass: await timer?.read() };
}
