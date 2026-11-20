// Installed in the benchmark page before the library loads. Query reads happen after
// the timing window and only in a separate, explicitly instrumented run.
export function installMarkPassTimer(): void {
	if (typeof GPUAdapter === 'undefined') return;
	const request = GPUAdapter.prototype.requestDevice;
	GPUAdapter.prototype.requestDevice = async function (descriptor) {
		if (!this.features.has('timestamp-query')) return request.call(this, descriptor);
		const device = await request.call(this, {
			...descriptor,
			requiredFeatures: [...new Set([...(descriptor?.requiredFeatures ?? []), 'timestamp-query' as GPUFeatureName])],
		});
		const limit = 2048,
			querySet = device.createQuerySet({ type: 'timestamp', count: limit * 2 });
		let active = false,
			count = 0;
		const create = device.createCommandEncoder.bind(device);
		device.createCommandEncoder = desc => {
			const encoder = create(desc),
				begin = encoder.beginComputePass.bind(encoder);
			encoder.beginComputePass = pass => {
				if (!active || pass?.label !== 'lumen-marks') return begin(pass);
				if (count === limit) throw Error('Mark pass query limit exceeded');
				const i = count++ * 2;
				return begin({
					...pass,
					timestampWrites: { querySet, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 },
				});
			};
			return encoder;
		};
		window.markPassTimer = {
			start() {
				active = true;
				count = 0;
			},
			stop() {
				active = false;
			},
			async read() {
				if (!count) return [];
				const size = count * 16;
				const resolve = device.createBuffer({ size, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
				const output = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
				const command = create();
				command.resolveQuerySet(querySet, 0, count * 2, resolve, 0);
				command.copyBufferToBuffer(resolve, 0, output, 0, size);
				device.queue.submit([command.finish()]);
				try {
					await output.mapAsync(GPUMapMode.READ);
					const data = new BigUint64Array(output.getMappedRange());
					return Array.from({ length: count }, (_, i) => Number(data[i * 2 + 1]! - data[i * 2]!) / 1e6);
				} finally {
					resolve.destroy();
					output.destroy();
				}
			},
		};
		return device;
	};
}
declare global {
	interface Window {
		markPassTimer?: { start(): void; stop(): void; read(): Promise<number[]> };
	}
}
