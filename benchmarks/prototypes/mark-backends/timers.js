// Read queries only after the measured frames. A timer run is separate from the frame-time run.
export function glQueries(gl, timer) {
	const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
	if (!ext) throw new Error('WebGL2 timer queries unavailable');
	const queries = Array.from({ length: timer.frames }, () => gl.createQuery());
	gl.getParameter(ext.GPU_DISJOINT_EXT);
	timer.read = async () => {
		const deadline = performance.now() + 5000;
		while (!gl.getQueryParameter(queries.at(-1), gl.QUERY_RESULT_AVAILABLE)) {
			if (performance.now() > deadline) throw new Error('WebGL timer queries timed out');
			await new Promise(resolve => requestAnimationFrame(resolve));
		}
		if (gl.getParameter(ext.GPU_DISJOINT_EXT)) throw new Error('Disjoint GPU timers');
		return queries.map(q => gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
	};
	return {
		start: () => gl.beginQuery(ext.TIME_ELAPSED_EXT, queries[timer.index]),
		end: () => gl.endQuery(ext.TIME_ELAPSED_EXT),
	};
}

export function gpuQueries(device, timer) {
	const count = timer.frames * 2;
	const size = count * BigUint64Array.BYTES_PER_ELEMENT;
	const querySet = device.createQuerySet({ type: 'timestamp', count });
	timer.read = async () => {
		const resolved = device.createBuffer({ size, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
		const readback = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		const encoder = device.createCommandEncoder();
		encoder.resolveQuerySet(querySet, 0, count, resolved, 0);
		encoder.copyBufferToBuffer(resolved, 0, readback, 0, size);
		device.queue.submit([encoder.finish()]);
		await readback.mapAsync(GPUMapMode.READ);
		const times = new BigUint64Array(readback.getMappedRange());
		const durations = Array.from({ length: timer.frames }, (_, i) => Number(times[i * 2 + 1] - times[i * 2]) / 1e6);
		readback.unmap();
		return durations;
	};
	return i => ({ querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 });
}
