# Releasing

How the packages get to npm. The pipeline is built for three things:

- one maintainer
- a protected `main`
- no long-lived npm token anywhere

## What is published

| Package                | Contents                        |
| ---------------------- | ------------------------------- |
| `lumen-charts`         | Re-exports `@lumen-charts/core` |
| `@lumen-charts/core`   | The chart                       |
| `@lumen-charts/engine` | Data engine and worker entry    |
| `@lumen-charts/react`  | React binding                   |
| `@lumen-charts/vue`    | Vue binding                     |
| `@lumen-charts/svelte` | Svelte binding                  |
| `@lumen-charts/solid`  | Solid binding                   |

**Versioning:** all seven packages are released together under one version: a Changesets `fixed` group.

**Not published:** the example and the benchmark harness are private.

**Package contents:**

- `dist/` (JavaScript, declarations, source maps) and `src/`, so that source maps and declaration maps resolve.
- `README.md`, `LICENSE` (MIT) and the changelog.

## Flow

```text
feature PR + changeset ──► main ──► (changesets pile up)
                                         │
             pnpm version-packages ◄─────┘   on a branch, by the maintainer
                     │
             "version packages" PR ──► main ──► Release workflow
                                                  plan: which versions are not on npm?
                                                  publish: approve ► build, test, check,
                                                           npm publish (OIDC, provenance),
                                                           tag vX.Y.Z, GitHub release
```

1. **Add a changeset.** Every pull request that changes a package adds one with `pnpm changeset`: a bump level and a line for the changelog.
2. **Version the packages.** To release, run `pnpm version-packages` on a branch. It consumes the changesets, bumps every package to the next version, writes the changelogs and formats them. Open a pull request with the result.
   - Like every pull request, it needs a passing `verify` check before it can merge.
3. **Merge the version PR.** The **Release** workflow (`.github/workflows/release.yml`) runs on every push to `main`. Its first job, `plan`, runs `node scripts/release.ts plan`, which asks the registry which package versions are missing. A version is released only when all of these hold:
   - npm does not have it,
   - it is not `0.0.0` (never versioned),
   - no changesets are still pending (otherwise the version on `main` is not final).
4. **Approve and publish.** When a release is due, the `publish` job waits for approval in the `npm` environment. After approval it runs, in order:
   - build, tests and `pnpm release:check`
   - `npm publish` of each package, dependencies first: engine, core, then the rest
   - a `vX.Y.Z` tag
   - a GitHub release with the changelog sections of that version

**Publishing a missing version again:** run the workflow by hand (`workflow_dispatch`) after fixing what failed. Versions that are already on npm are skipped, so a partial publish can be finished this way.

## Why not `changesets/action`

The usual setup lets `changesets/action` open the "version packages" pull request. It is not used here, for two reasons:

- **A pull request opened with the workflow's `GITHUB_TOKEN` does not trigger other workflows.** Its required `verify` check would never run, and the protected `main` could not take it. Working around that needs a GitHub App or a personal token.
- **It needs a repository setting turned on.** Actions would have to be allowed to create pull requests, a setting that stays off.

Running `pnpm version-packages` by hand costs one command. Publishing still runs in CI, which is where the credentials and provenance matter.

## Security

- **No npm token.** The publish job authenticates with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers). GitHub issues a short-lived OIDC token for this repository, this workflow file and the `npm` environment, and npm accepts it only from that combination. Nothing can leak or expire, and npm attaches a provenance statement to every version.
- **Approval.** The `npm` environment accepts deployments only from protected branches, which means `main`, and requires a reviewer's approval for every release.
- **Least privilege.**
  - The `plan` job only reads.
  - The `publish` job gets `contents: write` (tag and release) and `id-token: write` (OIDC), nothing else.
  - The CI workflow's token is read-only.
- **Publishing is off until npm is set up.** The repository variable `NPM_PUBLISH` must be `true` for the `publish` job to run. Until then, `plan` notes in the run summary which version is ready.
- **What reaches npm is checked on every pull request.** `pnpm release:check` packs every package as it would be published and fails on any of these:
  - a missing or differing license copy, or a missing README
  - files other than `dist/`, `src/` and the docs
  - export targets that do not exist
  - source maps whose sources are not in the package
  - `workspace:` ranges left in the manifest
  - differing versions across the packages

## One-time setup

### On npm

1. **Create the scope.** Create the npm organization `lumen-charts` (free for public packages); it owns the `@lumen-charts` scope. Enable two-factor authentication for the account.
2. **First publish, from a local session.** Trusted publishing is configured per package, on a package that exists:

   ```sh
   pnpm version-packages              # in a PR: bump 0.0.0 to the first version, merge it
   git switch main && git pull
   npm login                          # with two-factor authentication
   pnpm build && pnpm release:check
   pnpm release:publish               # publishes every package npm does not have
   git tag v0.1.0 && git push origin v0.1.0
   ```

   A local publish has no provenance; only this first version lacks it.

3. **Add the trusted publisher.** For each of the seven packages: package settings → _Publishing access_ → _Trusted publisher_ → GitHub Actions, with:
   - organization or user: `kjmin-dev`
   - repository: `lumen-charts`
   - workflow file: `release.yml`
   - environment: `npm`

   npm 11.15 or later can do the same from the command line with `npm trust`.

4. **Disallow token publishing.** In the same settings, set publishing access to _Require two-factor authentication and disallow tokens_. Trusted publishing keeps working, and a stolen token cannot publish.

### On GitHub

- **The `npm` environment already exists:** deployments only from protected branches, approval by `kjmin-dev`.
- **Turn publishing on:** set the repository variable `NPM_PUBLISH` to `true` (Settings → Secrets and variables → Actions → Variables) once the trusted publishers are in place.

## Commands

| Command                             | What it does                                                          |
| ----------------------------------- | --------------------------------------------------------------------- |
| `pnpm changeset`                    | Adds a changeset to the current branch                                |
| `pnpm version-packages`             | Turns pending changesets into versions and changelogs                 |
| `pnpm release:check`                | Packs every package and checks what npm would receive (after a build) |
| `pnpm release:plan`                 | Shows which versions npm does not have and whether a release is due   |
| `pnpm release:publish`              | Publishes those versions; add `-- --dry-run` to try it                |
| `node scripts/release.ts notes <v>` | Release notes for version `v`, from the changelogs                    |

**Prereleases:** a version with a prerelease part, such as `0.2.0-beta.1` from `changeset pre enter beta`, is published under the `next` dist-tag instead of `latest`, and its GitHub release is marked as a prerelease.
