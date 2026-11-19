import { viewBinding } from './webgpu-view.js';
import { height, width } from './scene.js';

// Static points are indexed in source coordinates. Each price band also holds points whose
// 3-pixel marker extends into it. Appends remain in the time-sorted tail of the point buffer.
const tile = 16;
const columns = Math.ceil(width / tile);
const bands = Math.ceil(height / tile);

export function tileIndex(device, scene) {
	const offsets = new Uint32Array(columns * bands + 1);
	function visit(record) {
		for (let i = 0; i < scene.count; i++) {
			const x = Math.max(0, Math.min(columns - 1, Math.floor(scene.points[i * 2] / tile)));
			const y = scene.points[i * 2 + 1];
			const lo = Math.max(0, Math.floor((y - 1) / tile));
			const hi = Math.min(bands - 1, Math.floor((y + 1) / tile));
			for (let band = lo; band <= hi; band++) record(band * columns + x, i);
		}
	}
	visit(bin => offsets[bin + 1]++);
	for (let i = 1; i < offsets.length; i++) offsets[i] += offsets[i - 1];
	const next = offsets.slice(0, -1);
	const ids = new Uint32Array(offsets.at(-1));
	visit((bin, id) => {
		ids[next[bin]++] = id;
	});
	return [offsets, ids].map(data => {
		const buffer = device.createBuffer({
			size: Math.max(4, data.byteLength),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		if (data.byteLength) device.queue.writeBuffer(buffer, 0, data);
		return buffer;
	});
}

export function tileShader(format, immediate = false) {
	return `
${immediate ? 'requires immediate_address_space;' : ''}
struct View { size: vec2u, origin: vec2f, scale: f32, first: u32, end: u32, indexed: u32 }
${viewBinding(immediate)}
@group(0) @binding(1) var<storage, read> points: array<vec2f>;
@group(0) @binding(2) var output: texture_storage_2d<${format}, write>;
@group(0) @binding(3) var<storage, read> offsets: array<u32>;
@group(0) @binding(4) var<storage, read> ids: array<u32>;
var<workgroup> winners: array<atomic<u32>, 256>;
var<workgroup> tail: array<u32, 2>;

fn stamp(id: u32, origin: vec2i) {
	let p = points[id];
	let center = vec2i(floor(vec2f(p.x * view.scale, p.y) - view.origin));
	if (any(center < vec2i(0)) || any(center >= vec2i(view.size))) { return; }
	let local = center - origin;
	let lo = max(local - 1, vec2i(0));
	let hi = min(local + 1, vec2i(15));
	for (var y = lo.y; y <= hi.y; y++) {
		for (var x = lo.x; x <= hi.x; x++) {
			atomicMax(&winners[u32(y * 16 + x)], id + 1u);
		}
	}
}

fn tailBound(threshold: f32) -> u32 {
	var lo = max(view.indexed, view.first);
	var hi = view.end;
	while (lo < hi) {
		let mid = lo + (hi - lo) / 2u;
		if (floor(points[mid].x * view.scale) < threshold) { lo = mid + 1u; }
		else { hi = mid; }
	}
	return lo;
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
	let origin = vec2i(group.xy * 16u);
	// The screen tile can receive the edge of a square centered in a neighboring column.
	let left = f32(max(origin.x - 1, 0)) + view.origin.x;
	let right = f32(min(origin.x + 17, i32(view.size.x))) + view.origin.x;
	let columns = ${columns}u;
	let firstBin = u32(clamp(floor(left / (view.scale * 16.0)), 0.0, f32(columns - 1u)));
	let endBin = u32(clamp(ceil(right / (view.scale * 16.0)), 1.0, f32(columns)));
	let band = group.y * columns;
	for (var j = offsets[band + firstBin] + lane; j < offsets[band + endBin]; j += 64u) {
		let id = ids[j];
		if (id >= view.first && id < view.end) { stamp(id, origin); }
	}
	if (view.end > view.indexed) {
		if (lane == 0) { tail[0] = tailBound(left); }
		if (lane == 1) { tail[1] = tailBound(right); }
		workgroupBarrier();
		for (var j = tail[0] + lane; j < tail[1]; j += 64u) { stamp(j, origin); }
	}
	workgroupBarrier();
	for (var i = lane; i < 256u; i += 64u) {
		let pixel = vec2u(origin) + vec2u(i & 15u, i >> 4u);
		if (all(pixel < view.size)) {
			let last = atomicLoad(&winners[i]);
			var rgba = vec4f(0);
			if (last != 0) {
				rgba = vec4f(select(vec3f(239,83,80), vec3f(38,166,154), (last & 1u) != 0u) / 255.0, 1);
			}
			textureStore(output, pixel, rgba);
		}
	}
}`;
}
