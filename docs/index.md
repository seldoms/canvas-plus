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

## Notes

- Canvas projects and My Assets are primarily stored in the browser. WebDAV can be configured for cross-device synchronization.
- The AI API key is stored in the browser, which sends requests directly to OpenAI-compatible endpoints.
- The optional `canvas-server/` gateway keeps its own config and generated artifacts on disk; the canvas front-end still sends all requests itself, just pointed at the gateway.
