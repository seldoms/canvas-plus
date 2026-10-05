# Infinite Canvas Documentation Index

## Overview

- [Quick Start](/docs/overview/quick-start)
- [Features](/docs/overview/features)
- [Deploy on Render](/docs/overview/render)
- [Docker Deployment](/docs/overview/docker)
- [Third-party Prompt Sources](/docs/overview/third-party-prompt-repositories)

## Canvas Guide

- [Canvas Node Guide](/docs/canvas/canvas-node-manual)
- [Canvas Shortcuts](/docs/canvas/canvas-shortcuts)

## Development and Data

- [Local Development](/docs/development/local-development)
- [Canvas Data Structure](/docs/development/canvas-data-structure)
- [How the Local Codex Connection Works](/docs/development/local-codex-canvas)
- [Local Gateway and Drama Pipeline](/docs/development/local-gateway)

## Business

- [Open-source License](/docs/business/license)
- [Business Cooperation](/docs/business/business)

## Support and Security

- [Report a Vulnerability](/docs/support/security)
- [Sponsor the Project](/docs/support/sponsor)

## Project Progress

- [Changelog](/docs/progress/changelog)
- [Pending Tests](/docs/progress/pending-test)
- [TODO](/docs/progress/todo)

## Internal Research (not in site navigation)

Plain `.md` files under `docs/content/docs/progress/`, deliberately absent from `meta.json`
so they do not render in the docs site. Read them directly from the repository.

- `docs/content/docs/progress/prd.md` — **product requirements document**: positioning, the
  current state (three disconnected worlds), the target architecture with Project as a
  first-class entity and hybrid storage, the six-stage pipeline, canvas ⇄ pipeline integration,
  feature priorities, the **content-authoring policy (overseas release, faithful to the source,
  flag review risks but never rewrite)**, non-functional requirements, and open questions.
  This is the alignment baseline for all further work.
- `docs/content/docs/progress/development-plan.md` — **development plan** (the execution side of
  the PRD): findings from a three-angle investigation (asset reuse / data-flow break points /
  user cost), the critical break where `artifactUrl` is never written back so the five-stage
  pipeline is really four and a half, the seven identifier layers Project must add, four traps
  that bite on day one, the decision log (naming, artifact storage), and the P0-a→P2 work
  packages with acceptance criteria. Every claim is graded verified / investigated.
- `docs/content/docs/progress/libtv-product-analysis.md` — competitive teardown of LibTV
  (liblib.tv) at the **product and canvas** level: page features, design system, button design,
  and technical implementation, with findings graded confirmed / inferred / unverified. Written
  by the project owner and kept verbatim; the seven screenshots it references at the end were
  not supplied, so those links are dead. Distinct from `gateway-api-benchmark.md`, which
  benchmarks the LiblibAI **open platform API** rather than the LibTV **product**.
- `docs/content/docs/progress/gateway-api-benchmark.md` — generation-gateway API benchmark
  against a mature commercial platform (LiblibAI): capability matrix, three-layer gap verdict,
  additive API design on the frozen contract, prioritized catch-up plan, and the boundary
  values that still need owner confirmation.
- `docs/content/docs/progress/local-capability-audit.md` — local ComfyUI capability audit.
  Every measured number in the benchmark comes from here; conclusions are graded
  measured / documented / inferred.
- `docs/content/docs/progress/liblibai-api-reference.md` — factual digest of the benchmarked
  third-party API (endpoints, quotas, status enums, error codes) written in our own words.
  The source page requires login; a verbatim archive was deliberately **not** committed because
  `origin` is a public remote.
- `docs/content/docs/progress/local-asset-inventory.md` — inward-facing asset inventory of the
  local-first capabilities: structural moats, extractable engineering assets, design disciplines
  worth propagating, and the honest debt list, each item verified against code or a real run.
- `docs/content/docs/progress/h3-i2v-ui-evidence.md` — first-hand capture of a real UI-enqueued
  H3 i2v job's full `params.PROMPT` (job id, template, sizes, frame count, side-by-side with the
  old compiler's output), closing pilot-issue #66's evidence gap.
- `docs/content/docs/progress/platform-positioning.md` — **platform positioning and page
  responsibilities (draft v1, awaiting owner sign-off)**: one-sentence positioning, the three
  maturity tiers (this phase = ship the edit-ready package), the single responsibility of each
  page (project workspace / canvas / image workbench / video workbench / pipeline / assets), the
  five different things the word "workflow" currently means in this repo, the local-vs-cloud
  fact that **text already runs on cloud DeepSeek while image/video/audio stay local**, the local
  capability table, and ten registered contradictions (C1–C10) with nine decisions (P1–P9) for
  the owner. Read this before deciding what belongs on which page.
- `docs/content/docs/progress/project-integration-implementation-guide.md` — **Project 主线整合实施蓝图**：把 Project、Canvas、Workflow、Tool、生图/生视频工作台和七段流水线收敛到一条服务端事实链；给出 GenerationIntent 接线形态、页面职责、M0–M5 改造顺序、Kimi/千问文件边界以及真实 HTTP、GPU、产物回写和用户动线验收指标。
- `docs/content/docs/progress/local-agent-integration-plan.mdx` — **本地 Agent 接入计划**：记录 localhost + SSE/MCP 桥接、Canvas 与 Project 两种工具作用域、审批/幂等/审计边界，以及从画布 MVP 到资料包生产 MVP 的验收条件。
- `docs/content/docs/progress/external-solutions-and-skills-research.md` — **外部方案与短剧 Skill 调研**：核对 H3 Motion Context、原生 latent 续接、短剧生产系统和公开 Agent Skill，给出 H3 Continuation Provider、许可证、质量门禁和 P0/P1 采用顺序。

## Notes

- Canvas projects and My Assets are primarily stored in the browser. WebDAV can be configured for cross-device synchronization.
- The AI API key is stored in the browser, which sends requests directly to OpenAI-compatible endpoints.
- The optional `canvas-server/` gateway keeps its own config and generated artifacts on disk; the canvas front-end still sends all requests itself, just pointed at the gateway.
