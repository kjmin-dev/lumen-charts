import { canvas, colors, height, width, isPointPatch, isColumnPatch } from './scene.js';

// Compose a canonical mark image or an opaque dirty rectangle into the chart's 2D layer.
// The renderer remains responsible for uploading deferred source data before its next draw.
export function composeMarks({ target, screen, scene, draw, cachePan, hostPatches, nativePatches }) {
	const cache = cachePan ? canvas(width, height).getContext('2d') : null;
	cache?.drawImage(target, 0, 0);
	let valid = Boolean(cache);
	const stripe = hostPatches && scene.type === 'heatmap' ? screen.createImageData(1, height) : null;
	const pixels = stripe && new Uint32Array(stripe.data.buffer);
	const ramp = stripe && Uint32Array.from({ length: 256 }, (_, v) => (0xff800000 | ((255 - v) << 8) | v) >>> 0);
	const fills =
		hostPatches &&
		scene.type === 'scatter' &&
		colors.map(p => 'rgb(' + (p & 255) + ',' + ((p >>> 8) & 255) + ',' + ((p >>> 16) & 255) + ')');

	return (v, first, count, update) => {
		if (nativePatches && update) {
			const image = draw.nativePatch(v, first, count);
			if (image) {
				screen.drawImage(image, v.x, v.y);
				valid = false;
				return;
			}
		}
		if (hostPatches && update) {
			if (fills && isPointPatch(v, scene.points, first, count)) {
				draw.deferUpdate?.(first, count);
				screen.fillStyle = fills[first & 1];
				screen.fillRect(v.x, v.y, 3, 3);
				return;
			}
			if (stripe && isColumnPatch(v, count)) {
				const gain = scene.rangeControl ? v.gain : 256;
				for (let y = 0; y < scene.column.length; y++) {
					const value = scene.column[y];
					const color = ramp[gain === 256 ? value : Math.min(255, Math.floor((value * gain) / 256))];
					pixels[y * 2] = color;
					pixels[y * 2 + 1] = color;
				}
				draw.deferUpdate(first, count);
				screen.putImageData(stripe, v.x, v.y);
				valid = false;
				return;
			}
		}
		if (target.width !== v.w) target.width = v.w;
		if (target.height !== v.h) target.height = v.h;
		if (
			cache &&
			!update &&
			v.x === 0 &&
			v.y === 0 &&
			v.w === width &&
			v.h === height &&
			v.scale === 1 &&
			Number.isInteger(v.shift) &&
			(v.gain ?? 256) === 256
		) {
			if (!valid) {
				draw({ ...v, shift: 0 }, first, count, false);
				cache.clearRect(0, 0, width, height);
				cache.drawImage(target, 0, 0);
				valid = true;
			}
			screen.clearRect(0, 0, width, height);
			screen.drawImage(cache.canvas, -v.shift, 0);
			return;
		}
		draw(v, first, count, update);
		if (screen) {
			if (!update) screen.clearRect(0, 0, width, height);
			screen.drawImage(target, v.x, v.y);
		}
		if (cache && update) valid = false;
	};
}
