/** Stands in for the browser's throwaway profile directory, whose name is random. */
export const PROFILE_PLACEHOLDER = '<temporary-profile>';

/**
 * Removes paths that identify the machine from text recorded in a results file, such as the
 * browser's command line: the home directory becomes `~`, the temporary directory `$TMPDIR`, and
 * the profile directory a placeholder. Results files are committed, so they must not carry a user
 * name or local paths.
 *
 * @param prefixes local directories to replace, each with its replacement
 */
export function redactLocalPaths(text: string, prefixes: readonly (readonly [string, string])[]): string {
	let result = text.replace(/--user-data-dir=\S+/g, `--user-data-dir=${PROFILE_PLACEHOLDER}`);
	// Longest first, so a directory inside another one is replaced by its own name.
	const remaining = prefixes.filter(([path]) => path.length > 1);
	while (remaining.length > 0) {
		let longest = 0;
		for (let i = 1; i < remaining.length; i++) {
			if (remaining[i]![0].length > remaining[longest]![0].length) {
				longest = i;
			}
		}
		const [path, replacement] = remaining.splice(longest, 1)[0]!;
		result = result.split(path).join(replacement);
	}
	return result;
}
