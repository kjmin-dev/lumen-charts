// Immediates are optional. The control explicitly uses a uniform buffer; the experiment
// fails on unsupported adapters rather than recording both labels for the same path.
export function viewBinding(immediate) {
	return immediate ? 'var<immediate> view: View;' : '@group(0) @binding(0) var<uniform> view: View;';
}
export function requireImmediates(adapter, bytes) {
	if (
		!navigator.gpu.wgslLanguageFeatures.has('immediate_address_space') ||
		!(adapter.limits.maxImmediateSize >= bytes)
	) {
		throw new Error('Required WebGPU immediate data range is unavailable');
	}
}
