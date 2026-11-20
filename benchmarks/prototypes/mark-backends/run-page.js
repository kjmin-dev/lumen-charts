import { composeMarks } from './mark-layer.js';
import { canvas2d } from './canvas2d.js';
import { webgl2 } from './webgl2.js';
import { webgpu } from './webgpu.js';
import { webgpuMesh } from './webgpu-mesh.js';
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

function optimizedBackend(target, scene, timer, immediate = false) {
	// No cross-device switching threshold has been established. The M1 trial uses tiles
	// through the largest sparse cloud tested and columns for the million-point case.
	if (scene.type === 'scatter')
		return webgpuColumns(target, scene, timer, { tiled: scene.count <= 300000, transfer: true, immediate });
	return webgpu(target, scene, timer, false, { transfer: true, copyPan: false, immediate });
}

const backends = {
	canvas2d,
	webgl2,
	webgpu,
	webgl2Visible: visibleRange(webgl2),
	webgpuVisible: visibleRange(webgpu),
	webgpuColumns,
	webgpuMesh: visibleRange(webgpuMesh),
	webgpuTiles: (target, scene, timer) => webgpuColumns(target, scene, timer, { tiled: true }),
	webgpuPrior: (target, scene, timer) =>
		scene.type === 'scatter' ? webgpuColumns(target, scene, timer) : webgpu(target, scene, timer),
	webgpuRetained: (target, scene, timer) =>
		scene.type === 'scatter'
			? webgpuColumns(target, scene, timer, { transfer: true })
			: webgpu(target, scene, timer, false, { transfer: true }),
	canvas2dOptimized: canvas2d,
	webgpuSplit: (target, scene, timer) =>
		scene.type === 'scatter'
			? webgpuColumns(target, scene, timer, { transfer: true })
			: webgpu(target, scene, timer, false, { transfer: true, copyPan: false }),
	webgpuOptimized: optimizedBackend,
	webgpuImmediate: (target, scene, timer) => optimizedBackend(target, scene, timer, true),
	canvas2dCached: canvas2d,
	webgl2Cached: webgl2,
	webgpuCached: webgpu,
	webgpuDirect: webgpu,
	webgpuDirectBundle: (target, scene, timer) => webgpu(target, scene, timer, true),
};
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

async function digest(ctx) {
	const data = ctx.getImageData(0, 0, width, height).data;
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
	return Array.from(hash, n => n.toString(16).padStart(2, '0')).join('');
}

export async function run({
	backend,
	type,
	count,
	action,
	frames,
	check,
	gpuTimers,
	shape,
	checkSequence,
	varyRange,
	mixedCheck,
}) {
	const warmup = 12;
	const scene = makeScene(type, count, Math.max(16, warmup + frames + 1), shape);
	const direct = backend === 'webgpuDirect' || backend === 'webgpuDirectBundle';
	scene.rangeControl = varyRange !== undefined;
	const output = canvas(width, height);
	output.style.width = width / devicePixelRatio + 'px';
	output.style.height = height / devicePixelRatio + 'px';
	document.body.replaceChildren(output);
	const screen = direct ? null : output.getContext('2d');
	const target = direct ? output : canvas(width, height);
	const initStart = performance.now();
	const timer = gpuTimers ? { frames, index: -1 } : null;
	const draw = await backends[backend](target, scene, timer);
	const initial = viewFor('pan', 0, scene);
	initial.gain = 256;
	draw(initial, 0, count, false);
	screen?.drawImage(target, 0, 0);
	const optimized = backend.endsWith('Optimized') || backend === 'webgpuImmediate';
	const paint = composeMarks({
		target,
		screen,
		scene,
		draw,
		cachePan: backend.endsWith('Cached') || (optimized && type === 'heatmap'),
		hostPatches: optimized,
		nativePatches: backend === 'webgpuSplit',
	});
	const setupMs = performance.now() - initStart;
	// A tick composites only its dirty rectangle into the retained 2D destination.
	if (action === 'tick') {
		const v = viewFor(action, 0, scene);
		target.width = v.w;
		target.height = v.h;
	}
	let appended = 0;
	function render(frame) {
		const mixed = action === 'tick-redraw';
		const update = action === 'tick' || (mixed && frame % 8 !== 7);
		const sourceFrame = mixed && update ? appended : frame;
		if (update) updateScene(scene, sourceFrame);
		const v = mixed && !update ? initial : viewFor(update ? 'tick' : action, sourceFrame, scene);
		if (scene.rangeControl) v.gain = varyRange ? 256 + (((frame + 1) * 3) % 173) : 256;
		const total = count + (mixed && type === 'scatter' ? appended : 0);
		paint(v, update ? count + sourceFrame : 0, update ? 1 : total, update);
		if (mixed && update) appended++;
	}
	if (check) {
		// Direct GPU frames only use a 2D canvas for this untimed verification.
		const readback = screen ?? canvas(width, height).getContext('2d');
		const hash = () => {
			if (direct) {
				readback.clearRect(0, 0, width, height);
				readback.drawImage(output, 0, 0);
			}
			return digest(readback);
		};
		const before = await hash();
		if (checkSequence) {
			const sequence = [];
			for (let i = 0; i < 16; i++) {
				render(i);
				sequence.push(await hash());
			}
			if (new Set(sequence).size < 2) throw new Error('Rendered frames did not change');
			if (mixedCheck) {
				// Patch a full view, then exercise the updated source, cached pans and fallback.
				// A changed range on a tick must invalidate a cache of the original colors.
				for (const gain of [256, 336]) {
					const whole = { ...initial, gain };
					paint(whole, 0, count, false);
					updateScene(scene, 0);
					if (type === 'heatmap') {
						for (let row = 0; row < scene.column.length; row++) scene.cells[(row + 1) * width - 1] = scene.column[row];
					}
					paint({ ...viewFor('tick', 0, scene), gain }, count, 1, true);
					sequence.push(await hash());
					for (const [scale, shift] of [
						[1, 0],
						[1, 1],
						[1, -11],
						[1, 142],
						[2, 250],
					]) {
						paint({ ...initial, scale, shift, gain: 256 }, 0, count + (type === 'scatter' ? 1 : 0), false);
						sequence.push(await hash());
					}
				}
			}
			return { before, sequence };
		}
		render(1);
		const middle = await hash();
		render(8);
		const after = await hash();
		if (before === after) throw new Error('Rendered frame did not change');
		return { before, middle, after };
	}
	const js = [];
	const stamps = [];
	const flushJs = [];
	for (let frame = 0; frame < warmup + frames; frame++) {
		const stamp = await nextFrame();
		if (frame === warmup) performance.mark('marks:start');
		if (timer) timer.index = frame - warmup;
		const start = performance.now();
		render(frame);
		if (frame >= warmup) {
			const elapsed = performance.now() - start;
			js.push(elapsed);
			if (action === 'tick-redraw' && frame % 8 === 7) flushJs.push(elapsed);
			stamps.push(stamp);
		}
	}
	stamps.push(await nextFrame());
	performance.mark('marks:end');
	return { js, stamps, setupMs, preparation: draw.preparation, flushJs, gpuPass: await timer?.read() };
}
