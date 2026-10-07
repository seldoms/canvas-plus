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

- [Pending Tests](/docs/progress/pending-test)
- [TODO](/docs/progress/todo)

## Internal Docs (not in site navigation)

Plain `.md` files under `docs/content/docs/progress/`, deliberately absent from `meta.json`.
**Current authoritative docs** — historical process docs (milestone plans, research, audits, pilot-issue logs) are archived under `progress/archive/`, frozen at their writing date:

- `prd.md` — **product requirements document**: positioning, target architecture, content-authoring policy, feature priorities. The alignment baseline for all work.
- `development-plan.md` — **development plan** (currently v4): execution scheduling; the current main line is the skeleton's P0–P3 sequence.
- `project-centric-skeleton.md` — **product skeleton**: the project-centric five-entry integration shape, gap list, and landing path.
- `domain-contract.md` — **domain contract (frozen)**: production-chain vocabulary, fields, and stable IDs.
- `model-registry-contract.md` — **model registry contract**: read-only registry, aliases, and categories.
- `ui-interaction-spec.md` — **interaction spec**: UI rules and acceptance rules (acceptance must walk the full user journey).
- `audio-video-quality-audit-2026-10-06.md` — audio/lip-sync quality audit and acceptance gates (**sound quality acceptance is open — current focus**).
- `liblibai-api-reference.md` — factual digest of the third-party platform API (optional backend reference).

## Notes

- Canvas projects and My Assets are primarily stored in the browser. WebDAV can be configured for cross-device synchronization.
- The AI API key is stored in the browser, which sends requests directly to OpenAI-compatible endpoints.
- The optional `canvas-server/` gateway keeps its own config and generated artifacts on disk; the canvas front-end still sends all requests itself, just pointed at the gateway.
