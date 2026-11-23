// A Markdown copy of every English page, for coding agents and anyone who wants the text
// without the site chrome around it: the page's address with `.md` in place of the trailing
// slash, so `/guides/indicators/` is also at `/guides/indicators.md`.

import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';

export const getStaticPaths: GetStaticPaths = async () => {
	const pages = await getCollection('docs', entry => entry.id !== 'ko' && !entry.id.startsWith('ko/'));
	return pages.map(entry => ({
		params: { slug: entry.id === 'index' ? 'index' : entry.id },
		props: { entry },
	}));
};

/** Removes shared leading indentation (spaces or tabs) from a block extracted from an MDX tag. */
function dedent(block: string): string {
	const lines = block.replace(/^\n+|\n+$/g, '').split('\n');
	const indents = lines
		.filter(line => line.trim() !== '')
		.map(line => {
			const match = line.match(/^[ \t]*/);
			return match === null ? '' : match[0];
		});
	if (indents.length === 0) {
		return '';
	}
	let common = indents[0]!;
	for (const indent of indents.slice(1)) {
		let i = 0;
		while (i < common.length && i < indent.length && common[i] === indent[i]) {
			i++;
		}
		common = common.slice(0, i);
	}
	if (common === '') {
		return lines.join('\n').trim();
	}
	return lines
		.map(line => (line.startsWith(common) ? line.slice(common.length) : line))
		.join('\n')
		.trim();
}

/** Strips MDX imports, comments, interactive chart frames, and purely decorative swatches. */
function plain(body: string): string {
	return body
		.replace(/^import .* from ['"](@astrojs\/starlight\/components|.*\.astro)['"];?$/gm, '')
		.replace(/^\{\/\*.*\*\/\}$/gm, '')
		.replace(/^<!--.*-->$/gm, '')
		.replace(/^<ChartDemo .*\/>$/gm, '')
		.replace(/<InstallCommand packages="([^"]+)"\s*\/>/g, (_, pkgs: string) => {
			return [
				'```sh',
				`pnpm add ${pkgs}`,
				`# npm:  npm install ${pkgs}`,
				`# yarn: yarn add ${pkgs}`,
				`# bun:  bun add ${pkgs}`,
				'```',
			].join('\n');
		})
		.replace(/^<p class="demo-caption">[\s\S]*?<\/p>$/gm, '')
		.replace(/^<div class="(?:ramp|theme-sample)[^"]*">.*<\/div>$/gm, '')
		.replace(/<span class="swatch"[^>]*><\/span>/g, '')
		.replace(/\{' '\}/g, ' ')
		.replace(/<code>([^<]+)<\/code>/g, '`$1`')
		.replace(/<Aside([^>]*)>([\s\S]*?)<\/Aside>/g, (_, attrs: string, inner: string) => {
			const titleMatch = attrs.match(/title="([^"]+)"/);
			const prefix = titleMatch !== null ? `**${titleMatch[1]}:** ` : '';
			const content = dedent(inner)
				.split('\n')
				.map((line, i) => `> ${i === 0 ? prefix : ''}${line}`)
				.join('\n');
			return `\n\n${content}\n\n`;
		})
		.replace(/<Card title="([^"]+)"[^>]*>([\s\S]*?)<\/Card>/g, (_, title: string, inner: string) => {
			return `\n\n### ${title}\n\n${dedent(inner)}\n\n`;
		})
		.replace(/<TabItem label="([^"]+)"[^>]*>([\s\S]*?)<\/TabItem>/g, (_, label: string, inner: string) => {
			return `\n\n### ${label}\n\n${dedent(inner)}\n\n`;
		})
		.replace(/<\/?(?:CardGrid|Tabs)[^>]*>/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export const GET: APIRoute = ({ props }) => {
	const { data, body } = props.entry;
	const text = plain(body ?? '');
	const description =
		data.description !== undefined && data.description !== '' && !text.startsWith(data.description)
			? `> ${data.description}\n\n`
			: '';
	return new Response(`# ${data.title}\n\n${description}${text}\n`, {
		headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
	});
};
