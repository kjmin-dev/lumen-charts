// The three backends receive identical, already projected series data in device pixels.
export const width = 2400;
export const height = 1200;
export const rows = 600;
export const colors = [0xff9aa626, 0xff5053ef];

export function makeScene(type, count, extra, shape = 'cloud') {
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
	if (shape === 'fractional') {
		for (let i = 0; i < count; i++) points[i * 2] = Math.floor((i * (width - 4) * 32) / count) / 32 + 1;
	}
	if (shape === 'burst') {
		// Put the middle 7/8 of the points into 1/32 of the time range. Timestamps
		// stay sorted and include many ties, as in a burst of trades.
		for (let i = 0; i < count; i++) {
			const t = i / count;
			let x;
			if (t < 1 / 16) x = t * 16 * (31 / 64);
			else if (t < 15 / 16) x = 31 / 64 + (t - 1 / 16) / 28;
			else x = 33 / 64 + (t - 15 / 16) * 16 * (31 / 64);
			points[2 * i] = Math.floor(x * (width - 4)) + 1;
		}
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

// A complete opaque patch can be transferred or composited without running the full renderer.
export function isPointPatch(v, points, first, count) {
	return (
		count === 1 &&
		v.w === 3 &&
		v.h === 3 &&
		points[first * 2] - v.x === 1 &&
		points[first * 2 + 1] - v.y === 1 &&
		v.scale === 1 &&
		v.shift === 0
	);
}

export function isColumnPatch(v, count) {
	return count === 1 && v.w === 1 && v.h === height && v.x === width - 1 && v.y === 0 && v.scale === 1 && v.shift === 0;
}

export function canvas(w, h) {
	const el = document.createElement('canvas');
	el.width = w;
	el.height = h;
	return el;
}
