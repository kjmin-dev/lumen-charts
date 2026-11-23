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

/** Strips MDX imports, comments, interactive chart frames, and purely decorative swatches. */
function plain(body: string): string {
	return body
		.replace(/^import .* from ['"](@astrojs\/starlight\/components|.*\.astro)['"];?$/gm, '')
		.replace(/^\{\/\*.*\*\/\}$/gm, '')
		.replace(/^<!--.*-->$/gm, '')
		.replace(/^<ChartDemo .*\/>$/gm, '')
		.replace(/^<p class="demo-caption">[\s\S]*?<\/p>$/gm, '')
		.replace(/^<div class="(?:ramp|theme-sample)[^"]*">.*<\/div>$/gm, '')
		.replace(/<span class="swatch"[^>]*><\/span>/g, '')
		.replace(/\{' '\}/g, ' ')
		.replace(/<code>([^<]+)<\/code>/g, '`$1`')
		.replace(/<\/?(?:CardGrid|Tabs)[^>]*>/g, '')
		.replace(/^\s*<Card title="([^"]+)"[^>]*>/gm, '### $1\n')
		.replace(/^\s*<\/Card>/gm, '')
		.replace(/^\s*<TabItem label="([^"]+)"[^>]*>/gm, '### $1\n')
		.replace(/^\s*<\/TabItem>/gm, '')
		.replace(/^\t+(?=### |```)/gm, '')
		.replace(/^\t{2}(?=\S)/gm, '')
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
