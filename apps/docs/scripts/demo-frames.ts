// Shortens the way to the live chart demos embedded on the docs pages.
//
// Each demo is a page of its own, in a frame. As built, it appears only at the end of a chain
// of requests, each waiting for the one before: the docs page, the frame's page, its stylesheet,
// and its scripts. After the build, this adds `modulepreload` links for every module a demo loads,
// and writes each demo page into its frame as `srcdoc`, so the frame starts as soon as the docs
// page arrives. The frame keeps its `src`, which the dev server uses because it does not run this.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

export function demoFrames(): AstroIntegration {
	return {
		name: 'demo-frames',
		hooks: {
			'astro:build:done': async ({ dir, logger }) => {
				const root = fileURLToPath(dir);
				const demoDir = join(root, 'demo');
				const examples = new Map<string, string>();
				const demoNames = await readdir(demoDir);
				await Promise.all(
					demoNames.map(async name => {
						const file = join(demoDir, name, 'index.html');
						const html = await preloadModules(await readFile(file, 'utf8'), root);
						await writeFile(file, html);
						examples.set(name, html);
					}),
				);

				let frames = 0;
				const files = (await readdir(root, { recursive: true })).filter(
					path => path.endsWith('.html') && !path.startsWith('demo/'),
				);
				await Promise.all(
					files.map(async path => {
						const file = join(root, path);
						const html = await readFile(file, 'utf8');
						if (!html.includes('data-demo=')) {
							return;
						}
						const framed = html.replace(/<iframe data-demo="([^"]+)"/g, (tag, name: string) => {
							const example = examples.get(name);
							if (example === undefined) {
								throw new Error(`${path} embeds the demo "${name}", which has no page`);
							}
							frames++;
							return `${tag} srcdoc="${example.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`;
						});
						// A frame the pattern missed would quietly keep the slow way; fail the build instead.
						if (framed.split('data-demo=').length !== framed.split('srcdoc=').length) {
							throw new Error(`${path} has a demo frame that demo-frames.ts did not recognize`);
						}
						await writeFile(file, framed);
					}),
				);
				logger.info(`wrote ${examples.size} chart demos into ${frames} frames`);
			},
		},
	};
}

/** Adds a `modulepreload` link for each module a demo page loads, and each module it imports. */
async function preloadModules(html: string, root: string): Promise<string> {
	const scripts = new Set(captures(html, /<script type="module" src="([^"]+)"/g));
	const modules = new Set<string>();
	const visit = async (url: string): Promise<void> => {
		if (modules.has(url) || !url.startsWith('/')) {
			return;
		}
		modules.add(url);
		const code = await readFile(join(root, url), 'utf8');
		const imports = captures(code, /(?:from|import)\s*"(\.{1,2}\/[^"]+\.js)"/g);
		await Promise.all(imports.map(path => visit(new URL(path, `file://${url}`).pathname)));
	};
	await Promise.all([...scripts].map(url => visit(url)));
	const links = [...modules]
		.filter(url => !scripts.has(url))
		.map(url => `<link rel="modulepreload" href="${url}">`)
		.join('');
	return html.replace('</head>', `${links}</head>`);
}

/** The first group of each match. */
function captures(text: string, pattern: RegExp): string[] {
	return [...text.matchAll(pattern)].flatMap(match => (match[1] === undefined ? [] : [match[1]]));
}
