import { gpuQueries } from './timers.js';
import { rows, width } from './scene.js';

const uniforms = `
struct View { size: vec2f, origin: vec2f, scale: f32, gain: f32 }
@group(0) @binding(0) var<uniform> view: View;
`;
const scatterShader =
	uniforms +
	`
struct Vertex {
	@builtin(position) position: vec4f,
	@location(0) @interpolate(flat) side: u32,
}
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) i: u32, @location(0) point: vec2f) -> Vertex {
	let center = vec2f(floor(point.x * view.scale), point.y) - view.origin;
	let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u));
	let p = center - 1.0 + corner * 3.0;
	var clip = p / view.size * vec2f(2, -2) + vec2f(-1, 1);
	if (any(center < vec2f(0)) || any(center >= view.size)) { clip = vec2f(2); }
	return Vertex(vec4f(clip, 0, 1), i & 1u);
}
@fragment fn fs(v: Vertex) -> @location(0) vec4f {
	return vec4f(select(vec3f(38,166,154), vec3f(239,83,80), v.side != 0u) / 255.0, 1);
}`;
const heatShader = rangeControl =>
	uniforms +
	`
@group(0) @binding(1) var cells: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	let corner = vec2f(f32(i & 1u), f32(i >> 1u));
	return vec4f(corner * 2.0 - 1.0, 0, 1);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
	let x = i32(floor((p.x + view.origin.x) / view.scale));
	if (x < 0 || x >= i32(textureDimensions(cells).x)) { discard; }
	let y = i32(floor((p.y + view.origin.y) * 0.5));
	var v = textureLoad(cells, vec2i(x, y), 0).r;
	${rangeControl ? 'v = min(255.0, floor(round(v * 255.0) * view.gain / 256.0)) / 255.0;' : ''}
	return vec4f(v, 1.0 - v, 128.0/255.0, 1);
}`;

export async function webgpu(target, scene, timer, useBundle = false) {
	const adapter = await navigator.gpu?.requestAdapter();
	if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware WebGPU adapter unavailable');
	const device = await adapter.requestDevice({ requiredFeatures: timer ? ['timestamp-query'] : [] });
	const timestampWrites = timer && gpuQueries(device, timer);
	device.addEventListener('uncapturederror', e => {
		throw new Error(e.error.message);
	});
	const ctx = target.getContext('webgpu');
	const format = navigator.gpu.getPreferredCanvasFormat();
	ctx.configure({ device, format, alphaMode: 'premultiplied' });
	const scatter = scene.type === 'scatter';
	const module = device.createShaderModule({ code: scatter ? scatterShader : heatShader(scene.rangeControl) });
	const pipeline = await device.createRenderPipelineAsync({
		layout: 'auto',
		vertex: {
			module,
			entryPoint: 'vs',
			buffers: scatter
				? [
						{
							arrayStride: 8,
							stepMode: 'instance',
							attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
						},
					]
				: [],
		},
		fragment: { module, entryPoint: 'fs', targets: [{ format }] },
		primitive: { topology: 'triangle-strip' },
	});
	const transform = new Float32Array(8);
	const uniformsBuffer = device.createBuffer({
		size: transform.byteLength,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	const entries = [{ binding: 0, resource: { buffer: uniformsBuffer } }];
	let points;
	let cells;
	if (scatter) {
		points = device.createBuffer({
			size: scene.points.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(points, 0, scene.points);
	} else {
		cells = device.createTexture({
			size: [width, rows],
			format: 'r8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		device.queue.writeTexture({ texture: cells }, scene.cells, { bytesPerRow: width }, [width, rows]);
		entries.push({ binding: 1, resource: cells.createView() });
	}
	const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
	let bundles;
	if (useBundle) {
		const encoder = device.createRenderBundleEncoder({ colorFormats: [format] });
		encoder.setPipeline(pipeline);
		encoder.setBindGroup(0, group);
		encoder.draw(4);
		bundles = [encoder.finish()];
	}
	return (v, first, count, update) => {
		transform[0] = v.w;
		transform[1] = v.h;
		transform[2] = v.x + v.shift;
		transform[3] = v.y;
		transform[4] = v.scale;
		if (scene.rangeControl) transform[5] = v.gain;
		device.queue.writeBuffer(uniformsBuffer, 0, transform);
		if (update && scatter) device.queue.writeBuffer(points, first * 8, scene.points, first * 2, 2);
		if (update && !scatter)
			device.queue.writeTexture({ texture: cells, origin: [width - 1, 0] }, scene.column, { bytesPerRow: 1 }, [
				1,
				rows,
			]);
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			timestampWrites: timer?.index >= 0 ? timestampWrites(timer.index) : undefined,
			colorAttachments: [
				{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
			],
		});
		if (bundles) {
			pass.executeBundles(bundles);
		} else {
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, group);
			if (scatter) {
				pass.setVertexBuffer(0, points);
				pass.draw(4, count, 0, first);
			} else {
				pass.draw(4);
			}
		}
		pass.end();
		device.queue.submit([encoder.finish()]);
	};
}
