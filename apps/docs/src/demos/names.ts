export const DEMO_NAMES = [
	'hero',
	'indicators',
	'price-axes',
	'drawings',
	'heatmap-scatter',
	'time-zones',
	'events',
	'themes',
	'primitives',
	'playground',
] as const;

export type DemoName = (typeof DEMO_NAMES)[number];
