// The normal matrix remains the fixed Stage 5 comparison. Optional studies select
// matched controls for one optimization and rotate the selected backends between rounds.
const scatterCases = [
	{ type: 'scatter', count: 300000, action: 'zoom' },
	...['pan', 'zoom', 'tick'].map(action => ({ type: 'scatter', count: 1000000, action })),
];
const candidates = {
	immediates: {
		backends: ['canvas2d', 'webgl2', 'webgpuOptimized', 'webgpuImmediate'],
		cases: [
			{ type: 'scatter', count: 100000, action: 'zoom' },
			{ type: 'heatmap', count: 1440000, action: 'pan', varyRange: true },
		],
	},

	patches: {
		backends: ['canvas2dOptimized', 'webgpuRetained', 'webgpuSplit', 'webgpuOptimized'],
		cases: ['tick', 'tick-redraw'].flatMap(action =>
			['scatter', 'heatmap'].map(type => ({ type, action, count: type === 'scatter' ? 1000000 : 1440000 })),
		),
	},

	'tile-control': {
		backends: ['canvas2d', 'webgl2Visible', 'webgpuColumns', 'webgpuTiles'],
		cases: [
			{ type: 'scatter', count: 100000, action: 'zoom', shape: 'fractional' },
			{ type: 'scatter', count: 1000000, action: 'zoom', shape: 'burst' },
		],
	},

	'pan-cache': {
		backends: ['canvas2d', 'canvas2dCached', 'webgl2Cached', 'webgpuPrior', 'webgpuRetained', 'webgpuCached'],
		cases: [{ type: 'heatmap', count: 1440000, action: 'pan', varyRange: false }],
	},
	retained: {
		backends: ['canvas2d', 'webgl2', 'webgpuPrior', 'webgpuRetained'],
		cases: [
			{ type: 'heatmap', count: 1440000, action: 'pan', varyRange: false },
			{ type: 'heatmap', count: 1440000, action: 'pan', varyRange: true },
			{ type: 'heatmap', count: 1440000, action: 'tick' },
			{ type: 'scatter', count: 1000000, action: 'tick' },
			...['scatter', 'heatmap'].map(type => ({
				type,
				count: type === 'scatter' ? 1000000 : 1440000,
				action: 'tick-redraw',
			})),
		],
	},

	sparse: {
		backends: ['canvas2d', 'webgl2Visible', 'webgpuColumns', 'webgpuMesh', 'webgpuTiles'],
		cases: [25000, 100000, 300000].map(count => ({ type: 'scatter', count, action: 'zoom' })),
	},
};
candidates.optimized = {
	backends: ['canvas2dOptimized', 'webgl2', 'webgpuPrior', 'webgpuOptimized'],
	cases: [{ type: 'scatter', count: 100000, action: 'zoom' }, ...candidates.retained.cases],
};

export function selectStudy(study, scatterPaths, heatPaths, gpuTimers) {
	if ([Boolean(study), scatterPaths, heatPaths].filter(Boolean).length > 1)
		throw new Error('Choose one path study per run');
	if (study !== undefined) {
		if (!Object.hasOwn(candidates, study)) throw new Error('Unknown study: ' + study);
		if (gpuTimers && ['retained', 'pan-cache', 'optimized', 'patches'].includes(study)) {
			throw new Error(
				'Queue texture writes and copies fall outside pass timestamps. Run this study without --gpu-timers.',
			);
		}
		return candidates[study];
	}
	const backends = ['canvas2d', 'webgl2', 'webgpu'];
	if (heatPaths) {
		return {
			backends: [...backends, 'webgpuDirect', 'webgpuDirectBundle'],
			cases: [false, true].map(varyRange => ({ type: 'heatmap', count: 1440000, action: 'pan', varyRange })),
		};
	}
	if (scatterPaths) {
		return {
			backends: [...backends, 'webgl2Visible', 'webgpuVisible', 'webgpuColumns'],
			cases: [
				{ type: 'scatter', count: 100000, action: 'zoom' },
				...scatterCases,
				{ type: 'scatter', count: 1000000, action: 'zoom', shape: 'burst' },
			],
		};
	}
	return {
		backends,
		cases: [...scatterCases, ...['pan', 'zoom', 'tick'].map(action => ({ type: 'heatmap', count: 1440000, action }))],
	};
}
