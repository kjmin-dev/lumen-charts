import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';
import { demoFrames } from './scripts/demo-frames.ts';

// The public address of the site. `llms.txt`, the sitemap and canonical links are built from it,
// so a deployment sets DOCS_SITE. Without it the links point at the local preview server.
const site = process.env.DOCS_SITE || 'http://localhost:4321';

const pkg = (name, entry = 'src/index.ts') =>
	fileURLToPath(new URL(`../../packages/${name}/${entry}`, import.meta.url));

export default defineConfig({
	site,
	trailingSlash: 'always',
	// Fetch a page while the pointer rests on its link, so it is often in before the click.
	prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
	integrations: [
		starlight({
			title: 'Lumen Ticks',
			description:
				'High-performance financial charting engine for the web: constant-time ticks, millions of bars in a worker, built-in and custom indicators, GPU heatmaps and scatter series, and thin framework bindings.',
			favicon: '/favicon.svg',
			logo: {
				src: './src/assets/logo.svg',
				alt: 'Lumen Ticks',
			},
			defaultLocale: 'root',
			locales: {
				root: { label: 'English', lang: 'en' },
				ko: { label: '한국어', lang: 'ko' },
			},
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/kjmin-dev/lumen-ticks' }],
			editLink: { baseUrl: 'https://github.com/kjmin-dev/lumen-ticks/edit/main/apps/docs/' },
			customCss: ['./src/styles/site.css'],
			plugins: [
				starlightLlmsTxt({
					projectName: 'Lumen Ticks',
					description:
						'Lumen Ticks is a high-performance financial charting engine for the web. History and indicators run in a worker-backed columnar engine with automatic level of detail, while the main thread renders candlesticks, lines, histograms, GPU heatmaps and scatter series, drawings, primitives, multiple price axes, time zones and trading sessions, with thin bindings for React, Vue, Svelte and Solid.',
					// The Korean pages translate the English entry pages; one language is enough for a model.
					exclude: ['ko', 'ko/**'],
					customSelectors: {
						all: [
							'.chart-demo',
							'.demo-caption',
							'.ramp',
							'.theme-sample',
							'.install-cmd__header',
							'.install-cmd__prompt',
						],
					},
				}),
			],
			sidebar: [
				{
					label: 'Start',
					translations: { ko: '시작하기' },
					items: [{ slug: 'getting-started' }, { slug: 'frameworks' }, { slug: 'playground' }],
				},
				{
					label: 'Guides',
					translations: { ko: '가이드' },
					items: [{ autogenerate: { directory: 'guides' } }],
				},
				{
					label: 'Reference',
					translations: { ko: '레퍼런스' },
					items: [{ autogenerate: { directory: 'reference' } }],
				},
				{
					label: 'Design & Performance',
					translations: { ko: '설계 및 성능' },
					items: [{ slug: 'architecture' }, { slug: 'benchmarks' }],
				},
				{
					label: 'Project',
					translations: { ko: '프로젝트' },
					items: [{ slug: 'releasing' }, { slug: 'hosting' }],
				},
			],
		}),
		demoFrames(),
	],
	vite: {
		resolve: {
			alias: {
				'@lumen-ticks/engine/worker': pkg('engine', 'src/worker.ts'),
				'@lumen-ticks/engine': pkg('engine'),
				'@lumen-ticks/core/worker': pkg('core', 'src/worker.ts'),
				'@lumen-ticks/core': pkg('core'),
			},
		},
	},
});
