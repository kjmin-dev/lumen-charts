// Verifies the built documentation site in apps/docs/dist, its generated Markdown/LLM outputs,
// its inlined chart demo frames, its internal links, and its Cloudflare Workers config.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { GUIDE_EXAMPLES } from '../scripts/guide-examples.ts';
import { DEMO_NAMES } from '../src/demos/names.ts';

const FRAMEWORK_LABELS = ['Vanilla', 'React', 'Vue 3', 'Svelte 5', 'Solid'] as const;

const docsRoot = join(import.meta.dirname, '..');
const repoRoot = join(docsRoot, '../..');
const dist = join(docsRoot, 'dist');

async function walkHtml(dir: string, prefix = ''): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async entry => {
			const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				return walkHtml(join(dir, entry.name), rel);
			}
			return entry.name.endsWith('.html') ? [rel] : [];
		}),
	);
	return nested.flat();
}

describe('docs build output', () => {
	test('every guide in docs/guide/ is built as both HTML and plain Markdown', async () => {
		const guides = (await readdir(join(repoRoot, 'docs/guide')))
			.filter(file => file.endsWith('.md'))
			.map(file => file.slice(0, -3));
		assert.ok(guides.length >= 15, `expected at least 15 guides, found ${guides.length}`);

		await Promise.all(
			guides.map(async slug => {
				assert.ok(existsSync(join(dist, 'guides', slug, 'index.html')), `missing HTML page for /guides/${slug}/`);
				const mdPath = join(dist, 'guides', `${slug}.md`);
				assert.ok(existsSync(mdPath), `missing Markdown copy for /guides/${slug}.md`);
				const md = await readFile(mdPath, 'utf8');
				assert.ok(md.startsWith('# '), `/guides/${slug}.md should begin with an H1 heading`);
				assert.ok(!md.includes('<ChartDemo'), `/guides/${slug}.md should strip ChartDemo tags`);
			}),
		);
	});

	test('core English, Korean, reference, and LLM files exist', async () => {
		const required = [
			'index.html',
			'index.md',
			'getting-started/index.html',
			'getting-started.md',
			'frameworks/index.html',
			'frameworks.md',
			'playground/index.html',
			'playground.md',
			'architecture/index.html',
			'architecture.md',
			'benchmarks/index.html',
			'benchmarks.md',
			'releasing/index.html',
			'releasing.md',
			'hosting/index.html',
			'hosting.md',
			'reference/api/index.html',
			'reference/indicators/index.html',
			'reference/palettes-and-themes/index.html',
			'reference/options/index.html',
			'reference/drawings/index.html',
			'ko/index.html',
			'ko/getting-started/index.html',
			'ko/frameworks/index.html',
			'ko/playground/index.html',
			'ko/hosting/index.html',
			'llms.txt',
			'llms-full.txt',
			'llms-small.txt',
			'_headers',
			'favicon.svg',
		];
		for (const rel of required) {
			assert.ok(existsSync(join(dist, rel)), `missing expected build artifact: ${rel}`);
		}

		const llms = await readFile(join(dist, 'llms.txt'), 'utf8');
		assert.ok(llms.includes('Lumen Ticks'), 'llms.txt should include project title');
		assert.ok(!llms.includes('/ko/'), 'llms.txt should exclude Korean translations');
		assert.ok(!existsSync(join(dist, 'ko.md')), 'Korean landing page should not be emitted as /ko.md');
	});

	test('framework wrapper tabs are synced across getting-started, frameworks, and all guides with code', async () => {
		const guideSlugs = Object.keys(GUIDE_EXAMPLES);
		assert.ok(
			guideSlugs.length >= 14,
			`expected at least 14 guides with framework examples, found ${guideSlugs.length}`,
		);

		const htmlTargets = [
			'getting-started/index.html',
			'frameworks/index.html',
			'ko/getting-started/index.html',
			'ko/frameworks/index.html',
			...guideSlugs.map(slug => `guides/${slug}/index.html`),
		];

		await Promise.all(
			htmlTargets.map(async rel => {
				const html = await readFile(join(dist, rel), 'utf8');
				assert.ok(
					html.includes('data-sync-key="framework"'),
					`${rel} should include synced framework tabs (data-sync-key="framework")`,
				);
				for (const label of FRAMEWORK_LABELS) {
					assert.ok(html.includes(`>${label}</a>`), `${rel} is missing a "${label}" framework tab`);
				}
			}),
		);

		const mdTargets = ['getting-started.md', 'frameworks.md', ...guideSlugs.map(slug => `guides/${slug}.md`)];
		await Promise.all(
			mdTargets.map(async rel => {
				const md = await readFile(join(dist, rel), 'utf8');
				assert.ok(
					!/<\/?(?:Tabs|TabItem|Aside|CardGrid|Card|InstallCommand)\b/.test(md),
					`${rel} contains unstripped MDX tags`,
				);
				assert.ok(!/^```[a-z]+\s+\S+.*```$/m.test(md), `${rel} contains a collapsed single-line fenced code block`);
				for (const label of FRAMEWORK_LABELS) {
					assert.ok(md.includes(`### ${label}\n`), `${rel} is missing "### ${label}" section`);
				}
			}),
		);

		const apiMd = await readFile(join(dist, 'reference', 'api.md'), 'utf8');
		assert.ok(apiMd.includes('## Framework bindings'), 'reference/api.md should document framework bindings');
	});

	test('install command boxes support pnpm/npm/yarn/bun and copy buttons across EN and KO pages', async () => {
		const installPages = [
			{ rel: 'getting-started/index.html', copyLabel: 'Copy' },
			{ rel: 'frameworks/index.html', copyLabel: 'Copy' },
			{ rel: 'ko/getting-started/index.html', copyLabel: '복사' },
			{ rel: 'ko/frameworks/index.html', copyLabel: '복사' },
		];

		await Promise.all(
			installPages.map(async ({ rel, copyLabel }) => {
				const html = await readFile(join(dist, rel), 'utf8');
				assert.ok(html.includes('<lumen-install'), `${rel} should render <lumen-install> command boxes`);
				for (const pm of ['pnpm', 'npm', 'yarn', 'bun']) {
					assert.ok(html.includes(`data-pm="${pm}"`), `${rel} is missing "${pm}" package manager tab`);
				}
				assert.ok(
					html.includes(`data-cmd="npm install @lumen-ticks/react react"`),
					`${rel} is missing React npm install command`,
				);
				assert.ok(
					html.includes(`data-copy-label="${copyLabel}"`),
					`${rel} is missing localized copy label "${copyLabel}"`,
				);
			}),
		);

		await Promise.all(
			['getting-started.md', 'frameworks.md'].map(async rel => {
				const md = await readFile(join(dist, rel), 'utf8');
				assert.ok(md.includes('pnpm add @lumen-ticks/core'), `${rel} should expand pnpm install command`);
				assert.ok(md.includes('npm install @lumen-ticks/react react'), `${rel} should expand npm install command`);
				assert.ok(md.includes('yarn add @lumen-ticks/vue vue'), `${rel} should expand yarn install command`);
				assert.ok(md.includes('bun add @lumen-ticks/solid solid-js'), `${rel} should expand bun install command`);
			}),
		);

		const llmsFull = await readFile(join(dist, 'llms-full.txt'), 'utf8');
		assert.ok(
			llmsFull.includes('pnpm add @lumen-ticks/react react'),
			'llms-full.txt should include React install command',
		);
		assert.ok(
			llmsFull.includes('npm install @lumen-ticks/vue vue'),
			'llms-full.txt should include Vue install command',
		);
		assert.ok(
			llmsFull.includes('yarn add @lumen-ticks/svelte svelte'),
			'llms-full.txt should include Svelte install command',
		);
		assert.ok(
			llmsFull.includes('bun add @lumen-ticks/solid solid-js'),
			'llms-full.txt should include Solid install command',
		);
	});

	test('every demo page is built and every embedded frame is inlined as srcdoc with modulepreload', async () => {
		await Promise.all(
			DEMO_NAMES.map(async name => {
				const demoHtml = join(dist, 'demo', name, 'index.html');
				assert.ok(existsSync(demoHtml), `missing built demo page /demo/${name}/index.html`);
				const content = await readFile(demoHtml, 'utf8');
				assert.ok(content.includes('<meta name="robots" content="noindex"'), `/demo/${name}/ must be noindex`);
			}),
		);

		const htmlFiles = (await walkHtml(dist)).filter(file => !file.startsWith('demo/'));
		const counts = await Promise.all(
			htmlFiles.map(async file => {
				const html = await readFile(join(dist, file), 'utf8');
				if (!html.includes('data-demo=')) {
					return 0;
				}
				const dataDemos = html.match(/data-demo="[^"]+"/g) ?? [];
				const srcdocs = html.match(/srcdoc="/g) ?? [];
				assert.equal(
					srcdocs.length,
					dataDemos.length,
					`${file} has ${dataDemos.length} demo frames but ${srcdocs.length} inlined srcdoc attributes`,
				);
				return dataDemos.length;
			}),
		);
		const frameCount = counts.reduce((sum, count) => sum + count, 0);
		assert.ok(frameCount >= 10, `expected at least 10 embedded demo frames across docs, found ${frameCount}`);
	});

	test('internal docs links resolve to built pages', async () => {
		const htmlFiles = (await walkHtml(dist)).filter(file => !file.startsWith('demo/'));
		const found = await Promise.all(
			htmlFiles.map(async file => {
				const html = await readFile(join(dist, file), 'utf8');
				const broken: string[] = [];
				for (const match of html.matchAll(
					/href="(\/(?:guides|reference|ko|getting-started|frameworks|playground|architecture|benchmarks|releasing|hosting)[^"]*)"/g,
				)) {
					const raw = match[1]!;
					const pathOnly = raw.split('#')[0]!;
					if (pathOnly.endsWith('.md')) {
						if (!existsSync(join(dist, pathOnly.slice(1)))) {
							broken.push(`${file} -> ${raw}`);
						}
						continue;
					}
					const target = pathOnly.endsWith('/')
						? join(dist, pathOnly.slice(1), 'index.html')
						: join(dist, pathOnly.slice(1));
					if (!existsSync(target)) {
						broken.push(`${file} -> ${raw}`);
					}
				}
				return broken;
			}),
		);
		const broken = found.flat();
		assert.deepEqual(broken, [], `broken internal links:\n${broken.join('\n')}`);
	});

	test('wrangler.jsonc configures lumen-ticks.studiocyf.app safely as static assets', async () => {
		const raw = await readFile(join(docsRoot, 'wrangler.jsonc'), 'utf8');
		assert.ok(
			raw.includes('"pattern": "lumen-ticks.studiocyf.app"'),
			'custom domain must be lumen-ticks.studiocyf.app',
		);
		assert.ok(raw.includes('"custom_domain": true'), 'must use Workers Custom Domain');
		assert.ok(raw.includes('"workers_dev": false'), 'must disable workers.dev');
		assert.ok(raw.includes('"preview_urls": false'), 'must disable preview_urls');
		assert.ok(!raw.includes('"account_id"'), 'must never commit account_id');
	});
});
