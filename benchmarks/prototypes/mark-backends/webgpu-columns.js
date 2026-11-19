import { height } from './scene.js';
import { gpuQueries } from './timers.js';

// Compute the final colors in a screen column. Each input square covers its center and one
// neighbor on each side. Later points overwrite earlier points, including across column edges.
function shader(format) {
	return `
struct View {
	size: vec2u,
	origin: vec2f,
	scale: f32,
	first: u32,
	end: u32,
}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> points: array<vec2f>;
@group(0) @binding(2) var output: texture_storage_2d<${format}, write>;

// WGSL initializes workgroup variables to zero. Row zero is a valid row; point indices
// are stored plus one so that a zero winner always denotes a transparent pixel.
var<workgroup> winners: array<atomic<u32>, ${height}>;
var<workgroup> bounds: array<u32, 2>;

fn lowerBound(column: u32) -> u32 {
	var lo = view.first;
	var hi = view.end;
	let threshold = view.origin.x + f32(column);
	while (lo < hi) {
		let mid = lo + (hi - lo) / 2u;
		if (floor(points[mid].x * view.scale) < threshold) { lo = mid + 1u; }
		else { hi = mid; }
	}
	return lo;
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
	let x = group.x;
	if (lane == 0) { bounds[0] = lowerBound(u32(max(i32(x) - 1, 0))); }
	if (lane == 1) { bounds[1] = lowerBound(min(x + 2u, view.size.x)); }
	workgroupBarrier();

	for (var i = bounds[0] + lane; i < bounds[1]; i += 64u) {
		let y = points[i].y - view.origin.y;
		if (y >= 0 && y < f32(view.size.y)) { atomicMax(&winners[u32(y)], i + 1u); }
	}
	workgroupBarrier();

	for (var y = lane; y < view.size.y; y += 64u) {
		var last = atomicLoad(&winners[y]);
		if (y > 0) { last = max(last, atomicLoad(&winners[y - 1u])); }
		if (y + 1u < view.size.y) { last = max(last, atomicLoad(&winners[y + 1u])); }
		var rgba = vec4f(0);
		if (last != 0) {
			rgba = vec4f(select(vec3f(239,83,80), vec3f(38,166,154), (last & 1u) != 0u) / 255, 1);
		}
		textureStore(output, vec2u(x, y), rgba);
	}
}`;
}

export async function webgpuColumns(target, scene, timer) {
	const adapter = await navigator.gpu?.requestAdapter();
	if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware WebGPU adapter unavailable');
	const requiredFeatures = timer ? ['timestamp-query'] : [];
	let format = navigator.gpu.getPreferredCanvasFormat();
	if (format === 'bgra8unorm' && adapter.features.has('bgra8unorm-storage')) {
		requiredFeatures.push('bgra8unorm-storage');
	} else {
		format = 'rgba8unorm';
	}
	const device = await adapter.requestDevice({ requiredFeatures });
	device.addEventListener('uncapturederror', event => {
		throw new Error(event.error.message);
	});
	const timestampWrites = timer && gpuQueries(device, timer);
	const ctx = target.getContext('webgpu');
	ctx.configure({
		device,
		format,
		alphaMode: 'premultiplied',
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
	});
	const pipeline = await device.createComputePipelineAsync({
		layout: 'auto',
		compute: { module: device.createShaderModule({ code: shader(format) }), entryPoint: 'main' },
	});
	const layout = pipeline.getBindGroupLayout(0);
	const points = device.createBuffer({
		size: scene.points.byteLength,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(points, 0, scene.points);
	const params = new Uint32Array(8);
	const floats = new Float32Array(params.buffer);
	const uniform = device.createBuffer({
		size: params.byteLength,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});

	return (v, first, count, update) => {
		params[0] = v.w;
		params[1] = v.h;
		floats[2] = v.x + v.shift;
		floats[3] = v.y;
		floats[4] = v.scale;
		params[5] = first;
		params[6] = first + count;
		device.queue.writeBuffer(uniform, 0, params);
		if (update) device.queue.writeBuffer(points, first * 8, scene.points, first * 2, 2);
		const group = device.createBindGroup({
			layout,
			entries: [
				{ binding: 0, resource: { buffer: uniform } },
				{ binding: 1, resource: { buffer: points } },
				{ binding: 2, resource: ctx.getCurrentTexture().createView() },
			],
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass({
			timestampWrites: timer?.index >= 0 ? timestampWrites(timer.index) : undefined,
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, group);
		pass.dispatchWorkgroups(v.w);
		pass.end();
		device.queue.submit([encoder.finish()]);
	};
}
