/// <reference types="node" />
// Release tooling for the published packages: checks what would be published, finds the versions
// that are not on npm yet, and publishes them. See docs/releasing.md.
//
//   node scripts/release.ts check              validate every package (run after `pnpm build`)
//   node scripts/release.ts plan               report what a release would publish
//   node scripts/release.ts publish [--dry-run] publish the versions npm does not have yet
//   node scripts/release.ts notes <version>    release notes for a version, from the changelogs

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const registry = 'https://registry.npmjs.org';

interface Manifest {
	name: string;
	version: string;
	private?: boolean;
	license?: string;
	files?: string[];
	main?: string;
	types?: string;
	exports?: unknown;
	repository?: { directory?: string };
	publishConfig?: { access?: string };
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

interface Package {
	/** Directory name under packages/. */
	dir: string;
	path: string;
	manifest: Manifest;
}

/** Publishable packages, each after the packages it depends on. */
function packages(): Package[] {
	const all: Package[] = [];
	for (const dir of readdirSync(join(root, 'packages'))) {
		const path = join(root, 'packages', dir);
		const file = join(path, 'package.json');
		if (!existsSync(file)) {
			continue;
		}
		const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
		if (manifest.private !== true) {
			all.push({ dir, path, manifest });
		}
	}
	const names = new Set(all.map(entry => entry.manifest.name));
	const ordered: Package[] = [];
	const visiting = new Set<string>();
	const visit = (entry: Package): void => {
		if (ordered.includes(entry)) {
			return;
		}
		if (visiting.has(entry.manifest.name)) {
			throw new Error(`Dependency cycle through ${entry.manifest.name}`);
		}
		visiting.add(entry.manifest.name);
		for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
			const target = all.find(other => other.manifest.name === dependency);
			if (target !== undefined && names.has(dependency)) {
				visit(target);
			}
		}
		visiting.delete(entry.manifest.name);
		ordered.push(entry);
	};
	for (const entry of all) {
		visit(entry);
	}
	return ordered;
}

/** Changesets not yet turned into versions. */
function pendingChangesets(): string[] {
	return readdirSync(join(root, '.changeset')).filter(file => file.endsWith('.md') && file !== 'README.md');
}

/** Every file path an `exports` map points to. */
function exportTargets(exports: unknown, out: string[] = []): string[] {
	if (typeof exports === 'string') {
		out.push(exports);
	} else if (exports !== null && typeof exports === 'object') {
		for (const value of Object.values(exports)) {
			exportTargets(value, out);
		}
	}
	return out;
}

/** Packs a package the way it is published (`workspace:` ranges resolved) and returns the tarball path. */
function pack(entry: Package, destination: string): string {
	const stdout = execFileSync('pnpm', ['pack', '--pack-destination', destination, '--json'], {
		cwd: entry.path,
		encoding: 'utf8',
	});
	const result = JSON.parse(stdout) as { filename: string } | { filename: string }[];
	const filename = Array.isArray(result) ? result[0]!.filename : result.filename;
	return resolve(destination, filename);
}

/** Unpacks a tarball into `destination` and returns its files, relative to the package root. */
function unpack(tarball: string, destination: string): string[] {
	mkdirSync(destination, { recursive: true });
	execFileSync('tar', ['-xzf', tarball, '-C', destination]);
	const files: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				walk(join(dir, entry.name), relative);
			} else {
				files.push(relative);
			}
		}
	};
	walk(join(destination, 'package'), '');
	return files;
}

/** Source maps in the tarball whose sources are not in it, as `map -> source`. */
function brokenSourceMaps(packageRoot: string, files: readonly string[]): string[] {
	const present = new Set(files);
	const broken: string[] = [];
	for (const file of files) {
		if (!file.endsWith('.map')) {
			continue;
		}
		const map = JSON.parse(readFileSync(join(packageRoot, file), 'utf8')) as {
			sources?: string[];
			sourceRoot?: string;
		};
		const dir = posix.dirname(file);
		for (const source of map.sources ?? []) {
			const target = posix.normalize(posix.join(dir, map.sourceRoot ?? '', source));
			if (!present.has(target)) {
				broken.push(`${file} -> ${target}`);
			}
		}
	}
	return broken;
}

function check(): void {
	const list = packages();
	const errors: string[] = [];
	const license = readFileSync(join(root, 'LICENSE'));
	const versions = new Set(list.map(entry => entry.manifest.version));
	if (versions.size > 1) {
		errors.push(`packages are released together but have versions ${[...versions].join(', ')}`);
	}
	const scratch = mkdtempSync(join(tmpdir(), 'lumen-release-check-'));
	try {
		for (const entry of list) {
			const { manifest, dir, path } = entry;
			const fail = (message: string): void => {
				errors.push(`${manifest.name}: ${message}`);
			};
			if (manifest.license !== 'MIT') {
				fail('license is not MIT');
			}
			const copy = join(path, 'LICENSE');
			if (!existsSync(copy) || !readFileSync(copy).equals(license)) {
				fail('LICENSE is missing or differs from the root LICENSE');
			}
			if (!existsSync(join(path, 'README.md'))) {
				fail('README.md is missing');
			}
			if (manifest.repository?.directory !== `packages/${dir}`) {
				fail(`repository.directory is not packages/${dir}`);
			}
			if (manifest.name.startsWith('@') && manifest.publishConfig?.access !== 'public') {
				fail('a scoped package needs publishConfig.access "public"');
			}
			for (const target of [manifest.main, manifest.types, ...exportTargets(manifest.exports)]) {
				if (target !== undefined && target !== './package.json' && !existsSync(join(path, target))) {
					fail(`${target} does not exist; run pnpm build first`);
				}
			}
			const tarball = pack(entry, scratch);
			const unpacked = join(scratch, dir);
			const files = unpack(tarball, unpacked);
			const packageRoot = join(unpacked, 'package');
			for (const required of ['package.json', 'LICENSE', 'README.md']) {
				if (!files.includes(required)) {
					fail(`the tarball has no ${required}`);
				}
			}
			const stray = files.filter(
				file =>
					!['package.json', 'LICENSE', 'README.md', 'CHANGELOG.md'].includes(file) &&
					!file.startsWith('dist/') &&
					!file.startsWith('src/'),
			);
			if (stray.length > 0) {
				fail(`the tarball holds files outside dist/ and src/: ${stray.join(', ')}`);
			}
			const broken = brokenSourceMaps(packageRoot, files);
			if (broken.length > 0) {
				fail(`source maps point at files the tarball lacks, such as ${broken.slice(0, 3).join(', ')}`);
			}
			if (files.some(file => file.endsWith('.test.js') || file.includes('/test/'))) {
				fail('the tarball holds tests');
			}
			const packed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Manifest;
			for (const [name, range] of Object.entries({ ...packed.dependencies, ...packed.peerDependencies })) {
				if (range.startsWith('workspace:')) {
					fail(`the published manifest keeps ${name}@${range}`);
				}
			}
			process.stdout.write(`ok ${manifest.name}@${manifest.version} (${files.length} files)\n`);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	if (errors.length > 0) {
		process.stderr.write(`${errors.map(error => `error: ${error}`).join('\n')}\n`);
		process.exit(1);
	}
}

/** True when npm already has this exact version. */
async function published(name: string, version: string): Promise<boolean> {
	const response = await fetch(`${registry}/${name.replace('/', '%2F')}`, {
		headers: { accept: 'application/vnd.npm.install-v1+json' },
	});
	if (response.status === 404) {
		return false;
	}
	if (!response.ok) {
		throw new Error(`npm registry answered ${response.status} for ${name}`);
	}
	const body = (await response.json()) as { versions?: Record<string, unknown> };
	return body.versions?.[version] !== undefined;
}

interface Plan {
	version: string;
	changesets: string[];
	pending: Package[];
	/** True when versioned packages that npm does not have are ready to go out. */
	releasable: boolean;
	reason: string;
}

async function plan(): Promise<Plan> {
	const list = packages();
	const version = list[0]?.manifest.version ?? '0.0.0';
	const changesets = pendingChangesets();
	const onNpm = await Promise.all(list.map(entry => published(entry.manifest.name, entry.manifest.version)));
	const pending = list.filter((_, i) => !onNpm[i]);
	let reason: string;
	if (pending.length === 0) {
		reason = `every package is on npm at ${version}`;
	} else if (version === '0.0.0') {
		reason = 'the packages have never been versioned (run pnpm version-packages)';
	} else if (changesets.length > 0) {
		reason = `${changesets.length} changeset(s) are waiting to be versioned (run pnpm version-packages)`;
	} else {
		reason = `${pending.length} package(s) at ${version} are not on npm`;
	}
	const releasable = pending.length > 0 && version !== '0.0.0' && changesets.length === 0;
	return { version, changesets, pending, releasable, reason };
}

/** Writes `name=value` lines for later steps of a GitHub Actions job. */
function output(values: Record<string, string>): void {
	const file = process.env['GITHUB_OUTPUT'];
	if (file !== undefined && file !== '') {
		appendFileSync(
			file,
			Object.entries(values)
				.map(([key, value]) => `${key}=${value}\n`)
				.join(''),
		);
	}
}

async function runPlan(): Promise<void> {
	const result = await plan();
	process.stdout.write(`version ${result.version}: ${result.reason}\n`);
	for (const entry of result.pending) {
		process.stdout.write(`  not on npm: ${entry.manifest.name}@${entry.manifest.version}\n`);
	}
	if (result.releasable && process.env['GITHUB_ACTIONS'] === 'true' && process.env['NPM_PUBLISH'] !== 'true') {
		process.stdout.write(
			`::notice::${result.version} is ready to publish, but publishing is off. Set the repository variable NPM_PUBLISH to true (docs/releasing.md).\n`,
		);
	}
	output({ releasable: String(result.releasable), version: result.version });
}

async function publish(dryRun: boolean): Promise<void> {
	const result = await plan();
	if (!result.releasable) {
		process.stdout.write(`nothing to publish: ${result.reason}\n`);
		return;
	}
	const scratch = mkdtempSync(join(tmpdir(), 'lumen-release-'));
	// In GitHub Actions, npm signs a provenance statement with the workflow's OIDC identity.
	const provenance = process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] !== undefined;
	const tag = result.version.includes('-') ? 'next' : 'latest';
	try {
		for (const entry of result.pending) {
			const tarball = pack(entry, scratch);
			const args = ['publish', tarball, '--access', 'public', '--tag', tag];
			if (provenance) {
				args.push('--provenance');
			}
			if (dryRun) {
				args.push('--dry-run');
			}
			process.stdout.write(
				`${dryRun ? 'would publish' : 'publishing'} ${entry.manifest.name}@${entry.manifest.version}\n`,
			);
			// Dependencies go first (see `packages`), so a dependent never points at a missing version.
			execFileSync('npm', args, { cwd: root, stdio: 'inherit' });
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	output({ published: String(!dryRun), version: result.version });
}

/** The changelog sections of every package for `version`, as Markdown. */
function notes(version: string): void {
	const parts: string[] = [];
	for (const entry of packages()) {
		const file = join(entry.path, 'CHANGELOG.md');
		if (!existsSync(file)) {
			continue;
		}
		const text = readFileSync(file, 'utf8');
		const start = text.indexOf(`## ${version}\n`);
		if (start === -1) {
			continue;
		}
		const rest = text.slice(start + `## ${version}\n`.length);
		const end = rest.search(/^## /m);
		const body = (end === -1 ? rest : rest.slice(0, end)).trim();
		if (body !== '') {
			parts.push(`## ${entry.manifest.name}\n\n${body}`);
		}
	}
	process.stdout.write(`${parts.join('\n\n')}\n`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
	case 'check':
		check();
		break;
	case 'plan':
		await runPlan();
		break;
	case 'publish':
		await publish(rest.includes('--dry-run'));
		break;
	case 'notes':
		notes(rest[0] ?? '');
		break;
	default:
		process.stderr.write('usage: node scripts/release.ts check | plan | publish [--dry-run] | notes <version>\n');
		process.exit(2);
}
