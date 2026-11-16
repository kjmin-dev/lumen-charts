# Custom indicators

A plugin is an ES module of indicator definitions. Its kernel runs inside the data engine, in the
worker or on the main thread when the page blocks workers, so the module is loaded by URL:

```ts
// my-indicators.js: a standalone module (no bare imports), served by the application
export default [
	{
		name: 'momentum',
		inputs: ['close'],
		outputs: [{ name: 'value', style: 'histogram', color: '#26a69a' }],
		params: [{ name: 'period', default: 10, min: 1, integer: true }],
		windowed: true, // values depend only on the last `lookback + 1` rows
		stateSize: () => 0,
		lookback: params => params[0],
		warmup: params => params[0],
		// Rows [offset, offset + length) of a column-major buffer (inputs, then outputs); the `carry`
		// input rows before `offset` hold the rows before the slice.
		kernel(buffer, offset, length, state, carry, params) {
			const stride = buffer.length / 2;
			for (let r = offset; r < offset + length; r++) {
				buffer[stride + r] = buffer[r] - buffer[r - params[0]];
			}
		},
	},
];
```

```ts
await chart.registerIndicators(new URL('./my-indicators.js', import.meta.url));
candles.addIndicator('momentum', { params: { period: 14 } });
```

The contract (`IndicatorKernel`, `IndicatorDefinition`) is documented in the types. A cumulative
kernel (the default) keeps its running values in `state`, which is zeros on a fresh start; a
`windowed` one must rebuild its state from the carry rows after a reset, which lets the engine
recompute only the rows near a prepend. The page's content security policy must allow the module
(`script-src`, and `blob:` for a module made from a Blob). Bundlers must leave it as a separate file
with a stable URL, for example in `public/`; the engine's `import()` is marked to be ignored by
Vite and webpack. To draw an output other than as a line or histogram, give it a custom renderer
(see [Primitives and custom renderers](primitives.md)).
