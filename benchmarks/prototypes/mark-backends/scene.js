// The three backends receive identical, already projected series data in device pixels.
export const width = 2400;
export const height = 1200;
export const rows = 600;
export const colors = [0xff9aa626, 0xff5053ef];

export function makeScene(type, count, extra) {
	if (type === 'heatmap') {
		const cells = new Uint8Array(width * rows);
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < width; x++) cells[y * width + x] = (x * 13 + y * 17) & 255;
		}
		return { type, cells, column: new Uint8Array(rows) };
	}
	const points = new Float32Array(2 * (count + extra));
	let seed = 13;
	for (let i = 0; i < count; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		points[2 * i] = Math.floor((i * (width - 4)) / count) + 1;
		points[2 * i + 1] = 1 + Math.floor((seed / 0x100000000) * (height - 2));
	}
	return { type, points, count };
}

export function updateScene(scene, frame) {
	if (scene.type === 'scatter') {
		const i = scene.count + frame;
		scene.points[2 * i] = width - 2;
		scene.points[2 * i + 1] = 1 + ((frame * 41) % (height - 2));
		return;
	}
	for (let y = 0; y < rows; y++) scene.column[y] = (frame * 71 + y * 29) & 255;
}

export function viewFor(action, frame, scene) {
	if (action === 'tick' && scene.type === 'scatter') {
		return { x: width - 3, y: scene.points[2 * (scene.count + frame) + 1] - 1, w: 3, h: 3, scale: 1, shift: 0 };
	}
	if (action === 'tick') return { x: width - 1, y: 0, w: 1, h: height, scale: 1, shift: 0 };
	const scale = action === 'zoom' ? 1 + (frame % 16) / 16 : 1;
	// Keep heatmap pixel centers away from exact nearest-neighbor ties on fractional zooms.
	const sampleOffset = action === 'zoom' && scene.type === 'heatmap' ? 1 / 32 : 0;
	const shift = action === 'pan' ? frame % 101 : Math.floor(((scale - 1) * width) / 2) + sampleOffset;
	return { x: 0, y: 0, w: width, h: height, scale, shift };
}

export function canvas(w, h) {
	const el = document.createElement('canvas');
	el.width = w;
	el.height = h;
	return el;
}
