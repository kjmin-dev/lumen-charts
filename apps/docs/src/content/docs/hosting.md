---
title: Hosting this site
description: How to build and deploy the Lumen Ticks documentation site to Cloudflare Workers as static assets at lumen-ticks.studiocyf.app.
---

This documentation site is an [Astro Starlight](https://starlight.astro.build) project in `apps/docs`. It is private to this repository and is never published to npm.

| Site          | Address                             | Source      | Workflow                     |
| ------------- | ----------------------------------- | ----------- | ---------------------------- |
| Documentation | `https://lumen-ticks.studiocyf.app` | `apps/docs` | `.github/workflows/docs.yml` |

## Build locally

```sh
pnpm docs:dev      # http://localhost:4321
pnpm docs:build    # writes apps/docs/dist
pnpm docs:preview  # preview the built static site locally
pnpm docs:test     # run generator and build output checks
```

Before `dev` or `build` runs, `apps/docs/scripts/generate.ts` writes the pages whose source of truth lives elsewhere in the repository so documentation cannot drift:

| Pages                      | Source                                                        |
| -------------------------- | ------------------------------------------------------------- |
| Guides (`/guides/*`)       | `docs/guide/*.md` (build fails if any guide file is unmapped) |
| Releasing (`/releasing/`)  | `docs/releasing.md`                                           |
| Reference (`/reference/*`) | `packages/core/src/*` and `packages/engine/src/*`             |

The build also produces:

- `/llms.txt`, `/llms-full.txt`, and `/llms-small.txt` via `starlight-llms-txt`
- A plain-Markdown copy of every English page with `.md` replacing the trailing slash (for example, `/guides/indicators.md` and `/reference/palettes-and-themes.md`)
- Preloaded inline `srcdoc` frames (`apps/docs/scripts/demo-frames.ts`) for every live chart demo so frames start loading alongside the host page instead of waiting on an extra round trip

## Deploy to Cloudflare Workers

`apps/docs/wrangler.jsonc` deploys `apps/docs/dist` to Cloudflare Workers as **static assets**. Because no Worker script runs, asset requests do not count against the Workers free plan's daily request limit.

To deploy manually from your machine, build first (setting `DOCS_SITE`), then run the deploy script using your `wrangler login` session:

```sh
DOCS_SITE=https://lumen-ticks.studiocyf.app pnpm docs:build
pnpm deploy:docs
```

The GitHub Actions workflow in `.github/workflows/docs.yml` does not deploy automatically until you configure it:

1. Create a Cloudflare API token as described in [The API token](#the-api-token).
2. In the GitHub repository settings, create an environment named `cloudflare`. Restrict its deployment branches to `main` only. Add the token as the environment secret `CLOUDFLARE_API_TOKEN` and your Cloudflare account ID as the environment secret `CLOUDFLARE_ACCOUNT_ID`. Use environment secrets — not repository secrets — so only runs on `main` can read them.
3. Optionally set the repository variable `DOCS_SITE` to your site's public address (defaults to `https://lumen-ticks.studiocyf.app`). Canonical links, the sitemap, and `llms.txt` are generated from this value.
4. Run the **Docs** workflow manually once from the Actions tab (`workflow_dispatch`) to verify the deployment.
5. To deploy automatically on every push to `main` that touches docs or library sources, set the repository variable `DOCS_DEPLOY` to `true`.

### The API token

Cloudflare cannot scope a token to a single Worker. Give the token only the permissions required for static-asset deployment and custom-domain routing:

| Scope   | Permission            | Resources                                             |
| ------- | --------------------- | ----------------------------------------------------- |
| Account | Workers Scripts: Edit | Only the account that holds the site                  |
| Zone    | Workers Routes: Edit  | Only the zone of `studiocyf.app` (or your own domain) |

Avoid the broad "Edit Cloudflare Workers" template, which also grants KV, R2, and Pages permissions this deployment never uses. Set an expiration date and rotate the token before it expires.

### How the workflow protects the token

This repository is public, so `.github/workflows/docs.yml` assumes anyone can read it and open a pull request:

- **No deploy on pull requests.** The workflow triggers only on `workflow_dispatch` and pushes to `main`. Fork pull requests never see any secret.
- **Branch-restricted environment.** Secrets live in the `cloudflare` environment, restricted to `main`.
- **Split build and deploy jobs.** The `build` job runs Astro, Vite, and workspace code with **zero secrets** and uploads `apps/docs/dist` as an artifact. The `deploy` job holds the Cloudflare credentials and runs only Wrangler on the uploaded artifact.
- **Lockfile-pinned Wrangler without install scripts or shared cache.** Wrangler is isolated in `tools/deploy` (`@lumen-ticks/deploy`), pinned to an exact version in `pnpm-lock.yaml`, with `esbuild` and `workerd` install scripts disabled in `pnpm-workspace.yaml`. The deploy job installs it with `--frozen-lockfile --ignore-scripts --filter @lumen-ticks/deploy` and disables tool/pnpm caching so untrusted build-job caches can never cross into the deploy job.
- **Commit-pinned actions.** Every GitHub Action in `docs.yml` is pinned to a full commit SHA, updated monthly with a 14-day cooldown via `.github/dependabot.yml`.
- **No account ID in git.** `wrangler.jsonc` intentionally omits `account_id`; Wrangler reads `CLOUDFLARE_ACCOUNT_ID` from the environment.

Never commit `.wrangler/` or `.dev.vars` — both are listed in `.gitignore`.

## Use a domain of your own

`apps/docs/wrangler.jsonc` attaches the Worker to `lumen-ticks.studiocyf.app` as a Workers Custom Domain (`custom_domain: true`). On deploy, Cloudflare provisions the DNS record and TLS certificate automatically:

- The domain's zone must exist in the same Cloudflare account, and the hostname must not already have a manual CNAME record.
- `workers_dev` and `preview_urls` are explicitly set to `false` so the site is served solely from its custom domain and never exposed on a `*.workers.dev` subdomain.

In a fork, replace `pattern` in `apps/docs/wrangler.jsonc` with your own hostname and set the `DOCS_SITE` repository variable to match. To deploy to a `workers.dev` subdomain instead, remove `routes` and set `workers_dev` to `true`.

## GitHub Pages alternative

You can also host the built `apps/docs/dist` folder on GitHub Pages without Cloudflare DNS: build with `DOCS_SITE=https://<your-domain> pnpm docs:build`, upload `apps/docs/dist` using `actions/upload-pages-artifact`, and deploy via `actions/deploy-pages`. Note that GitHub Pages ignores `public/_headers`, so immutable cache headers for `/_astro/*` and explicit `text/markdown` headers for `/*.md` only apply on Cloudflare Workers.
