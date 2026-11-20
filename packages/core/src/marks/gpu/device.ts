import type { GpuBackend, GpuLease, MarkRendererReason } from '../backend';
import { GpuMarkBackend } from './renderer';
import { columnShader, heatShader, tileShader } from './shaders';

export type MarkTextureFormat = 'bgra8unorm' | 'rgba8unorm';
export type GpuPath = 'heatmap' | 'scatter-tiles' | 'scatter-columns';
export interface GpuResources {
	device: GPUDevice;
	format: MarkTextureFormat;
	pipelines: Record<GpuPath, GPUComputePipeline>;
}
type Listener = (backend: GpuBackend | null, reason: MarkRendererReason | null) => void;
const pools = new WeakMap<Document, Pool>();

class Pool {
	public listeners = new Set<Listener>();
	public resources: GpuResources | null = null;
	public failure: MarkRendererReason | null = null;
	public device: GPUDevice | null = null;
	public disposed = false;

	private readonly doc: Document;
	public constructor(doc: Document) {
		this.doc = doc;
	}
	public async init(): Promise<void> {
		try {
			const adapter = await this.doc.defaultView?.navigator.gpu?.requestAdapter();
			if (this.disposed) return;
			if (!adapter || adapter.info?.isFallbackAdapter) {
				this.fail('unavailable');
				return;
			}
			const preferred = this.doc.defaultView!.navigator.gpu.getPreferredCanvasFormat();
			const format: MarkTextureFormat =
				preferred === 'bgra8unorm' && adapter.features.has('bgra8unorm-storage') ? 'bgra8unorm' : 'rgba8unorm';
			const device = await adapter.requestDevice({
				requiredFeatures: format === 'bgra8unorm' ? ['bgra8unorm-storage'] : [],
			});
			if (this.disposed) {
				device.destroy();
				return;
			}
			this.device = device;
			void device.lost.then(() => this.fail('device-lost'));
			device.addEventListener('uncapturederror', () => this.fail('render-failed'));
			const compile = (code: string) =>
				device.createComputePipelineAsync({
					layout: 'auto',
					compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
				});
			const [heat, tiles, columns] = await Promise.all([
				compile(heatShader(format)),
				compile(tileShader(format)),
				compile(columnShader(format)),
			]);
			if (this.disposed || this.failure) return;
			this.resources = {
				device,
				format,
				pipelines: { heatmap: heat, 'scatter-tiles': tiles, 'scatter-columns': columns },
			};
			for (const listener of this.listeners) this.notify(listener);
		} catch {
			this.fail('initialization-failed');
		}
	}
	public notify(listener: Listener): void {
		if (this.resources) listener(new GpuMarkBackend(this.doc, this.resources), null);
		else if (this.failure) listener(null, this.failure);
	}
	private fail(reason: MarkRendererReason): void {
		if (this.disposed || this.failure) return;
		this.failure = reason;
		this.resources = null;
		for (const listener of this.listeners) this.notify(listener);
		this.device?.destroy();
	}
}

export function acquire(doc: Document, listener: Listener): GpuLease {
	let pool = pools.get(doc);
	if (!pool) {
		pool = new Pool(doc);
		pools.set(doc, pool);
		void pool.init();
	}
	const shared = pool;
	shared.listeners.add(listener);
	shared.notify(listener);
	return {
		release() {
			if (!shared.listeners.delete(listener) || shared.listeners.size) return;
			shared.disposed = true;
			pools.delete(doc);
			shared.device?.destroy();
		},
	};
}
