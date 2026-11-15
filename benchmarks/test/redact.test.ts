import { describe, expect, it } from 'vitest';
import { redactLocalPaths } from '../src/redact.ts';

const prefixes = [
	['/Users/someone', '~'],
	['/var/folders/ab/xyz/T', '$TMPDIR'],
	['/private/var/folders/ab/xyz/T', '$TMPDIR'],
] as const;

describe('redactLocalPaths', () => {
	it('replaces the home directory, the temporary directory and the profile directory', () => {
		const line =
			'/Users/someone/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing ' +
			'--headless --user-data-dir=/var/folders/ab/xyz/T/playwright_chromiumdev_profile-Dm8owl ' +
			'--crash-dumps-dir=/private/var/folders/ab/xyz/T/dumps --remote-debugging-pipe';
		expect(redactLocalPaths(line, prefixes)).toBe(
			'~/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing ' +
				'--headless --user-data-dir=<temporary-profile> --crash-dumps-dir=$TMPDIR/dumps --remote-debugging-pipe',
		);
	});

	it('gives the same text when applied twice', () => {
		const once = redactLocalPaths('/Users/someone/chrome --user-data-dir=/var/folders/ab/xyz/T/profile-1', prefixes);
		expect(redactLocalPaths(once, prefixes)).toBe(once);
	});

	it('leaves text without local paths alone and ignores a root prefix', () => {
		expect(redactLocalPaths('--enable-gpu-rasterization /opt/chrome', [['/', '~']])).toBe(
			'--enable-gpu-rasterization /opt/chrome',
		);
	});
});
