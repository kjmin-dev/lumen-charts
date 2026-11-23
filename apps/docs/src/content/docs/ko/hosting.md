---
title: 사이트 호스팅
description: Lumen Charts 공식 문서 사이트를 빌드하고 Cloudflare Workers 정적 에셋으로 lumen-charts.studiocyf.app에 배포하는 방법을 안내합니다.
---

이 문서 사이트는 `apps/docs`에 있는 [Astro Starlight](https://starlight.astro.build) 프로젝트입니다. 저장소 내부용 비공개 워크스페이스 패키지이며 npm에는 배포되지 않습니다.

| 사이트    | 주소                                 | 소스        | 워크플로                     |
| --------- | ------------------------------------ | ----------- | ---------------------------- |
| 공식 문서 | `https://lumen-charts.studiocyf.app` | `apps/docs` | `.github/workflows/docs.yml` |

## 로컬 빌드

```sh
pnpm docs:dev      # http://localhost:4321
pnpm docs:build    # apps/docs/dist 생성
pnpm docs:preview  # 빌드된 정적 사이트 미리보기
pnpm docs:test     # 생성기 및 빌드 결과 검증 테스트
```

`dev`와 `build` 실행 전에 `apps/docs/scripts/generate.ts`가 저장소 곳곳의 원본 문서와 소스 코드에서 페이지를 자동 생성하므로 문서와 코드가 어긋나지 않습니다:

- `docs/guide/*.md` → `/guides/*` (매핑되지 않은 가이드 파일이 생기면 빌드가 실패합니다)
- `docs/releasing.md` → `/releasing/`
- `packages/core/src/*`, `packages/engine/src/*` → `/reference/*`

또한 빌드 시 `/llms.txt`, `/llms-full.txt`, `/llms-small.txt`와 모든 영문 페이지의 순수 마크다운 사본(`/<slug>.md`)이 함께 생성됩니다.

## Cloudflare Workers 배포

`apps/docs/wrangler.jsonc`는 `apps/docs/dist`를 Cloudflare Workers의 **정적 에셋(Static Assets)**으로 배포합니다. 실행되는 Worker 스크립트가 없으므로 정적 요청은 무료 플랜의 일일 Worker 요청 한도에 포함되지 않습니다.

로컬에서 수동 배포하려면 먼저 `DOCS_SITE`를 지정해 빌드한 뒤 `wrangler login` 세션으로 배포합니다:

```sh
DOCS_SITE=https://lumen-charts.studiocyf.app pnpm docs:build
pnpm deploy:docs
```

GitHub Actions(`.github/workflows/docs.yml`)로 자동 배포하려면 한 번만 아래를 설정하세요:

1. Cloudflare에서 최소 권한 API 토큰을 발급합니다 (`Workers Scripts: Edit` + `studiocyf.app` 존에 대한 `Workers Routes: Edit`).
2. GitHub 저장소 설정에서 `cloudflare` Environment를 만들고 배포 브랜치를 `main`으로만 제한합니다. 이 Environment의 시크릿으로 `CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID`를 등록합니다.
3. 필요하면 저장소 변수 `DOCS_SITE`를 설정합니다(미설정 시 기본값 `https://lumen-charts.studiocyf.app`).
4. Actions 탭에서 **Docs** 워크플로를 수동 실행(`workflow_dispatch`)해 배포를 확인합니다.
5. `main` 푸시마다 자동 배포하려면 저장소 변수 `DOCS_DEPLOY`를 `true`로 설정합니다.

보안 설계, API 토큰 세부 권한, 커스텀 도메인 및 GitHub Pages 대안에 대한 자세한 내용은 영문 [Hosting this site](/hosting/) 문서를 참고하세요.
