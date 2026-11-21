// Installed in the benchmark page before the library loads. Query reads happen after
// the timing window and only in a separate, explicitly instrumented run. Playwright
// serializes the function, so everything it uses is declared inside it.
export function installMarkPassTimer(): void {
	interface Timer {
		start(): void;
		stop(): void;
		read(): Promise<number[]>;
	}
	/** Queries per run, as many as a run measures frames at most and then some. */
	const limit = 2048;
	let gpu: Timer | null = null;
	let gl: Timer | null = null;

	// WebGPU: timestamps at the start and end of the chart's compute pass.
	if (typeof GPUAdapter !== 'undefined') {
		const request = GPUAdapter.prototype.requestDevice;
		GPUAdapter.prototype.requestDevice = async function (descriptor) {
			if (!this.features.has('timestamp-query')) return request.call(this, descriptor);
			const device = await request.call(this, {
				...descriptor,
				requiredFeatures: [...new Set([...(descriptor?.requiredFeatures ?? []), 'timestamp-query' as GPUFeatureName])],
			});
			const querySet = device.createQuerySet({ type: 'timestamp', count: limit * 2 });
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
			gpu = {
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

	// WebGL2: a TIME_ELAPSED query from the clear or draw that starts a series' paint to the draw
	// that ends it. The mark renderer is the only WebGL2 user of the page. Uploads before the
	// clear and the copy into the series' cache after the draw fall outside the query, as they
	// fall outside the WebGPU pass.
	if (typeof WebGL2RenderingContext !== 'undefined') {
		const TIME_ELAPSED_EXT = 0x88bf,
			GPU_DISJOINT_EXT = 0x8fbb;
		const proto = WebGL2RenderingContext.prototype;
		const { clear, drawArrays, drawArraysInstanced } = proto;
		const supported = new WeakMap<WebGL2RenderingContext, boolean>();
		const pending: { context: WebGL2RenderingContext; query: WebGLQuery }[] = [];
		const samples: number[] = [];
		let active = false,
			count = 0,
			open: WebGL2RenderingContext | null = null;
		const end = () => {
			if (open === null) return;
			open.endQuery(TIME_ELAPSED_EXT);
			open = null;
		};
		const begin = (context: WebGL2RenderingContext) => {
			if (!active || open !== null || count === limit) return;
			let ok = supported.get(context);
			if (ok === undefined) {
				ok = context.getExtension('EXT_disjoint_timer_query_webgl2') !== null;
				// Reading the flag clears it: only disjoint events from here on count.
				if (ok) context.getParameter(GPU_DISJOINT_EXT);
				supported.set(context, ok);
			}
			const query = ok ? context.createQuery() : null;
			if (query === null) return;
			count++;
			context.beginQuery(TIME_ELAPSED_EXT, query);
			pending.push({ context, query });
			open = context;
			// A paint whose clear has no draw after it (no marks in view) ends with its task.
			queueMicrotask(end);
		};
		/** Takes the results that are in, oldest first. A disjoint event voids every query in flight. */
		const poll = () => {
			while (pending.length) {
				const { context, query } = pending[0]!;
				if (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) return;
				if (context.getParameter(GPU_DISJOINT_EXT)) {
					for (const entry of pending.splice(0)) entry.context.deleteQuery(entry.query);
					return;
				}
				samples.push(Number(context.getQueryParameter(query, context.QUERY_RESULT)) / 1e6);
				context.deleteQuery(query);
				pending.shift();
			}
		};
		proto.clear = function (this: WebGL2RenderingContext, mask) {
			begin(this);
			clear.call(this, mask);
		};
		proto.drawArrays = function (this: WebGL2RenderingContext, mode, first, vertices) {
			begin(this);
			drawArrays.call(this, mode, first, vertices);
			end();
		};
		proto.drawArraysInstanced = function (this: WebGL2RenderingContext, mode, first, vertices, instances) {
			begin(this);
			drawArraysInstanced.call(this, mode, first, vertices, instances);
			end();
		};
		gl = {
			start() {
				active = true;
				count = 0;
				samples.length = 0;
				for (const entry of pending.splice(0)) entry.context.deleteQuery(entry.query);
			},
			stop() {
				end();
				active = false;
			},
			async read() {
				// Results arrive frames later; those that do not within the deadline are left out.
				const deadline = performance.now() + 5000;
				poll();
				while (pending.length && performance.now() < deadline) {
					await new Promise(resolve => requestAnimationFrame(resolve));
					poll();
				}
				for (const entry of pending.splice(0)) entry.context.deleteQuery(entry.query);
				return samples.splice(0);
			},
		};
	}

	window.markPassTimer = {
		start() {
			gpu?.start();
			gl?.start();
		},
		stop() {
			gpu?.stop();
			gl?.stop();
		},
		async read() {
			return [...((await gpu?.read()) ?? []), ...((await gl?.read()) ?? [])];
		},
	};
}
declare global {
	interface Window {
		markPassTimer?: { start(): void; stop(): void; read(): Promise<number[]> };
	}
}
