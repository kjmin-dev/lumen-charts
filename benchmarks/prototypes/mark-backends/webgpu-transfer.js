import { height, rows, width } from './scene.js';

// The dirty target is a new drawable. Every pixel in it is supplied by the update.
function pack(format, r, g, b) {
	return format === 'bgra8unorm'
		? (0xff000000 | (r << 16) | (g << 8) | b) >>> 0
		: (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

// Keep the whole-pane drawable alive when alternating patches and full redraws.
export function patchSurface(device, format, w, h) {
	let canvas;
	let context;
	return write => {
		if (!canvas) {
			canvas = new OffscreenCanvas(w, h);
			context = canvas.getContext('webgpu');
			context.configure({
				device,
				format,
				alphaMode: 'premultiplied',
				usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
			});
		}
		write(context.getCurrentTexture());
		return canvas;
	};
}

export function scatterPatch(device, format) {
	const colors = [pack(format, 38, 166, 154), pack(format, 239, 83, 80)];
	const marks = colors.map(color => new Uint32Array(9).fill(color));
	return (texture, id) => device.queue.writeTexture({ texture }, marks[id & 1], { bytesPerRow: 12 }, [3, 3]);
}

// Keep the R8 source as the authority. An extra precolored texture serves integral pans,
// including transparent pixels beyond the data. Other transforms use the original shader.
export function heatTransfers(device, format) {
	const guard = 128;
	const table = Uint32Array.from({ length: 256 }, (_, v) => pack(format, v, 255 - v, 128));
	const column = new Uint32Array(height);
	let cache;
	let dirty = false;
	function packColumn(values, gain) {
		for (let y = 0; y < rows; y++) {
			const color = table[gain === 256 ? values[y] : Math.min(255, Math.floor((values[y] * gain) / 256))];
			column[y * 2] = color;
			column[y * 2 + 1] = color;
		}
	}
	return {
		canCopy(v) {
			return (
				v.scale === 1 &&
				v.w === width &&
				v.h === height &&
				v.x === 0 &&
				v.y === 0 &&
				Number.isInteger(v.shift) &&
				v.shift >= 0 &&
				v.shift <= guard &&
				(v.shift !== 0 || cache !== undefined) &&
				(v.gain ?? 256) === 256
			);
		},
		pan(encoder, dest, v, fill) {
			if (!cache) {
				cache = device.createTexture({
					size: [width + guard, height],
					format,
					usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
				});
				fill(cache.createView());
			}
			encoder.copyTextureToTexture({ texture: cache, origin: [v.shift, 0] }, { texture: dest }, [width, height]);
		},
		writeColumn(texture, values, gain = 256) {
			packColumn(values, gain);
			device.queue.writeTexture({ texture }, column, { bytesPerRow: 4 }, [1, height]);
			dirty = true;
		},
		deferUpdate() {
			dirty = true;
		},
		sync(cells, values) {
			if (!dirty) return;
			device.queue.writeTexture({ texture: cells, origin: [width - 1, 0] }, values, { bytesPerRow: 1 }, [1, rows]);
			if (cache) {
				packColumn(values, 256);
				device.queue.writeTexture({ texture: cache, origin: [width - 1, 0] }, column, { bytesPerRow: 4 }, [1, height]);
			}
			dirty = false;
		},
	};
}
