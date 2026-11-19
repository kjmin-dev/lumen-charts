import { canvas, colors, height, rows, width } from './scene.js';

function heatColor(value) {
	return (0xff800000 | ((255 - value) << 8) | value) >>> 0;
}

export function canvas2d(target, scene) {
	const ctx = target.getContext('2d');
	let image;
	let pixels;
	if (scene.type === 'scatter') {
		return (v, first, count) => {
			if (image?.width !== v.w || image.height !== v.h) {
				image = ctx.createImageData(v.w, v.h);
				pixels = new Uint32Array(image.data.buffer);
			}
			pixels.fill(0);
			for (let i = first; i < first + count; i++) {
				const cx = Math.floor(scene.points[2 * i] * v.scale) - v.shift - v.x;
				const cy = scene.points[2 * i + 1] - v.y;
				if (cx < 0 || cx >= v.w || cy < 0 || cy >= v.h) continue;
				const color = colors[i % 2];
				// Same 3-by-3 square as the GPU point or instanced quad.
				if (cx > 0 && cx + 1 < v.w && cy > 0 && cy + 1 < v.h) {
					let at = (cy - 1) * v.w + cx - 1;
					for (let row = 0; row < 3; row++, at += v.w) {
						pixels[at] = color;
						pixels[at + 1] = color;
						pixels[at + 2] = color;
					}
					continue;
				}
				const left = Math.max(0, cx - 1);
				const right = Math.min(v.w - 1, cx + 1);
				for (let y = Math.max(0, cy - 1); y <= Math.min(v.h - 1, cy + 1); y++) {
					for (let x = left; x <= right; x++) pixels[y * v.w + x] = color;
				}
			}
			ctx.putImageData(image, 0, 0);
		};
	}

	// This affine, fixed-grid prototype can keep a precolored bitmap across viewport changes.
	const bitmap = canvas(width, rows);
	const bitmapCtx = bitmap.getContext('2d');
	image = bitmapCtx.createImageData(width, rows);
	pixels = new Uint32Array(image.data.buffer);
	for (let i = 0; i < pixels.length; i++) pixels[i] = heatColor(scene.cells[i]);
	bitmapCtx.putImageData(image, 0, 0);
	const stripe = bitmapCtx.createImageData(1, rows);
	const stripePixels = new Uint32Array(stripe.data.buffer);
	return (v, _first, _count, update) => {
		if (update) {
			for (let y = 0; y < rows; y++) stripePixels[y] = heatColor(scene.column[y]);
			bitmapCtx.putImageData(stripe, width - 1, 0);
		}
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, v.w, v.h);
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(bitmap, -v.x - v.shift, -v.y, width * v.scale, height);
	};
}
