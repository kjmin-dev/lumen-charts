import { gpuQueries } from './timers.js';

// One index pattern serves each block of markers. Vertices from many independent squares
// share an instance, instead of starting a separate four-vertex strip for every marker.
const blockSize = 4096;
const shader = `
struct View { size: vec2f, origin: vec2f, scale: f32, first: u32 }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> points: array<vec2f>;
struct Vertex { @builtin(position) position: vec4f, @location(0) @interpolate(flat) side: u32 }
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) block: u32) -> Vertex {
	let id = view.first + block * ${blockSize}u + (vertex >> 2u);
	let point = points[id];
	let center = vec2f(floor(point.x * view.scale), point.y) - view.origin;
	let corner = vec2f(f32(vertex & 1u), f32((vertex >> 1u) & 1u));
	var p = center - 1.0 + corner * 3.0;
	if (any(center < vec2f(0)) || any(center >= view.size)) { p = vec2f(-4); }
	return Vertex(vec4f(p / view.size * vec2f(2, -2) + vec2f(-1, 1), 0, 1), id & 1u);
}
@fragment fn fs(v: Vertex) -> @location(0) vec4f {
	return vec4f(select(vec3f(38,166,154), vec3f(239,83,80), v.side != 0u) / 255.0, 1);
}`;

export async function webgpuMesh(target, scene, timer) {
	const adapter = await navigator.gpu?.requestAdapter();
	if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware WebGPU adapter unavailable');
	const device = await adapter.requestDevice({ requiredFeatures: timer ? ['timestamp-query'] : [] });
	device.addEventListener('uncapturederror', event => {
		throw new Error(event.error.message);
	});
	const stamps = timer && gpuQueries(device, timer);
	const ctx = target.getContext('webgpu');
	const format = navigator.gpu.getPreferredCanvasFormat();
	ctx.configure({ device, format, alphaMode: 'premultiplied' });
	const module = device.createShaderModule({ code: shader });
	const pipeline = await device.createRenderPipelineAsync({
		layout: 'auto',
		vertex: { module, entryPoint: 'vs' },
		fragment: { module, entryPoint: 'fs', targets: [{ format }] },
		primitive: { topology: 'triangle-list' },
	});
	const indices = new Uint16Array(blockSize * 6);
	for (let i = 0; i < blockSize; i++) {
		const v = i * 4;
		indices.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
	}
	const index = device.createBuffer({
		size: indices.byteLength,
		usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(index, 0, indices);
	const points = device.createBuffer({
		size: scene.points.byteLength,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(points, 0, scene.points);
	const uniforms = new Float32Array(8);
	const words = new Uint32Array(uniforms.buffer);
	const view = device.createBuffer({
		size: uniforms.byteLength,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const group = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: view } },
			{ binding: 1, resource: { buffer: points } },
		],
	});
	return (v, first, count, update) => {
		uniforms[0] = v.w;
		uniforms[1] = v.h;
		uniforms[2] = v.x + v.shift;
		uniforms[3] = v.y;
		uniforms[4] = v.scale;
		words[5] = first;
		device.queue.writeBuffer(view, 0, uniforms);
		if (update) device.queue.writeBuffer(points, first * 8, scene.points, first * 2, 2);
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
			],
			timestampWrites: timer?.index >= 0 ? stamps(timer.index) : undefined,
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, group);
		pass.setIndexBuffer(index, 'uint16');
		const blocks = Math.floor(count / blockSize);
		if (blocks) pass.drawIndexed(indices.length, blocks);
		const tail = count % blockSize;
		if (tail) pass.drawIndexed(tail * 6, 1, 0, 0, blocks);
		pass.end();
		device.queue.submit([encoder.finish()]);
	};
}
