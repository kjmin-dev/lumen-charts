import { afterEach, describe, expect, it, vi } from 'vitest';
import type { acquire } from '../src/marks/gpu/device';
import { MarkGpuClient, type GpuBackend, type MarkRendererReason } from '../src/marks/backend';

const pool = vi.hoisted(() => ({ acquire: vi.fn<typeof acquire>() }));
vi.mock('../src/marks/gpu/device.js', () => pool);
const doc = { defaultView: { navigator: { gpu: {} } } } as unknown as Document;
afterEach(() => pool.acquire.mockReset());

describe('mark device lease lifetime', () => {
	it('ignores a late import after a series was removed', async () => {
		const client = new MarkGpuClient();
		client.start(doc, vi.fn<() => void>());
		client.release();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(pool.acquire).not.toHaveBeenCalled();
	});
	it('releases late devices without invalidating a new generation', async () => {
		let notify!: (backend: GpuBackend | null, reason: MarkRendererReason | null) => void;
		const invalidate = vi.fn<() => void>(),
			release = vi.fn<() => void>();
		pool.acquire.mockImplementation((_doc, listener) => {
			notify = listener;
			return { release };
		});
		const client = new MarkGpuClient();
		client.start(doc, invalidate);
		await vi.waitFor(() => expect(pool.acquire).toHaveBeenCalledTimes(1));
		const backend = { paint: vi.fn<GpuBackend['paint']>(), bytes: 0, release: vi.fn<() => void>() };
		notify(backend, null);
		expect(client.backend).toBe(backend);
		client.release();
		expect(release).toHaveBeenCalledOnce();
		expect(backend.release).toHaveBeenCalledOnce();
		notify(backend, null);
		expect(backend.release).toHaveBeenCalledTimes(2);
		expect(client.backend).toBeNull();
		expect(invalidate).toHaveBeenCalledOnce();
	});
});
