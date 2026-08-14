# helios Project Instructions

## 1. Project Snapshot

`helios` is a monorepo for a graph-oriented coding agent. The repository is organized around a shared kernel, protocol and port abstractions, multiple concrete implementations, and two applications:

- `apps/cli`: terminal entrypoint for the agent
- `apps/web`: browser UI + local host process

The codebase is TypeScript-first, ESM-based, and managed with `pnpm` workspaces.

## 2. Workspace Layout

### Root

- `package.json`: root scripts and shared dev dependencies
- `pnpm-workspace.yaml`: declares `packages/*` and `apps/*`
- `tsconfig.base.json`: shared TypeScript settings and path aliases
- `README.md`: minimal project summary
- `docs/`: architecture notes, review reports, and implementation plans

### Apps

- `apps/cli`: CLI entrypoint (`helios` binary)
- `apps/web`: Vite-based web app, plus host server process

### Packages

Core platform packages:

- `packages/ports`: shared type contracts and port interfaces
- `packages/protocol`: transport and RPC protocol helpers
- `packages/kernel`: orchestration core
- `packages/host`: host-side session/RPC wiring
- `packages/ui-chat`: chat UI primitives

Default/adaptor packages:

- `packages/fs-node`: filesystem implementation
- `packages/memory-fs`: in-memory filesystem
- `packages/checkpoint-fs`: checkpoint persistence
- `packages/checkpoint-git`: git-backed checkpointing
- `packages/compact-default`: session compaction strategy
- `packages/costmeter-default`: cost measurement implementation
- `packages/router-default`: model routing policy
- `packages/toolcache-mem`: in-memory tool result cache
- `packages/teams-mailbox`: team/handoff mailbox

Capability and model packages:

- `packages/capability-fs`
- `packages/cap-cron`
- `packages/cap-lsp`
- `packages/cap-mcp`
- `packages/llm-anthropic`
- `packages/llm-openai`

## 3. Tooling and Runtime

### Package manager and Node version

- `pnpm@8.15.1`
- Node `>=20.18.1`

### TypeScript

- strict mode enabled
- ESM modules
- bundler-style module resolution
- shared path aliases in `tsconfig.base.json`

### Root scripts

- `pnpm typecheck`: typecheck all workspace packages
- `pnpm test`: run Vitest test suite
- `pnpm cli`: start the CLI app
- `pnpm web`: start the web app + host process

## 4. App Entry Points

### CLI

- `apps/cli/src/index.ts`
- `apps/cli/package.json` exposes the `helios` binary via `tsx`

### Web

- `apps/web/server/host.ts`: host process for the web app
- `apps/web` uses Vite for frontend development and build
- `apps/web/src/App.tsx` contains the current UI view switching

## 5. Current Architecture Notes

The repository already reflects a port-and-adapter style design. The main architectural shape is:

- `ports` defines contracts
- `kernel` orchestrates runtime behavior
- concrete packages provide storage, LLM, checkpoint, and capability implementations
- `apps/web` composes the host and UI
- `apps/cli` composes the same core runtime for terminal use

The `docs/` directory contains the main design record for the project. The most relevant current documents are:

- `docs/three-client-status.md`
- `docs/web-ui-requirements.md`
- `docs/cost-optimization-layer.md`
- `docs/branch-tree-and-prompt-cache.md`
- `docs/compaction-records-in-message-tree.md`
- `docs/memory-module-design.md`
- `docs/memory-recall-prompt-cache-revision.md`
- `docs/shell-port-and-persistent-cwd.md`
- `docs/thinking-reasoning-support.md`
- `docs/code-review-and-cwd-isolation.md`
- `docs/agent-loop-review.md`

## 6. Development Commands

From the repository root:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm cli
pnpm web
```

Useful package-local commands:

- `pnpm --filter @helios/web dev`
- `pnpm --filter @helios/cli start`
- `pnpm --filter <package-name> typecheck`

## 7. Conventions

- Prefer workspace packages over relative deep imports.
- Keep shared contracts in `packages/ports` and `packages/protocol`.
- Put orchestration logic in `packages/kernel` or `packages/host`, not in app shells.
- Keep app packages thin: they should wire together existing primitives.
- Follow existing docs when adding new ports or runtime capabilities.

## 8. Practical Notes For New Work

- Start by checking whether a capability or behavior already exists in `docs/` before implementing it.
- If a change touches runtime flow, verify `packages/kernel`, `packages/host`, and the relevant adapter package together.
- If a change touches UI-visible behavior, check `apps/web` and `packages/ui-chat` together.
- If a change touches persistence, review `packages/checkpoint-fs`, `packages/memory-fs`, and any session storage path in `packages/kernel`.

## 9. Status Summary

This repository is not a single-purpose app. It is a platform-style monorepo with multiple runtime surfaces and a growing set of orthogonal ports. The safest way to extend it is to keep contracts narrow, implementations pluggable, and app layers thin.
