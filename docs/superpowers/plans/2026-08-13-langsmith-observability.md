# LangSmith Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional, failure-isolated LangSmith tracing for every Helios Agent run, LLM stream attempt, and tool invocation.

**Architecture:** Create `@helios/observability-langsmith` as the only package that imports `langsmith`. It exposes framework-neutral `Tracer`/`TraceRun` interfaces plus an environment-configured implementation and no-op fallback. Kernel accepts an injectable tracer (defaulting to the environment factory), creates the root run in `runTurnLoop`, and passes its child-run factory to the LLM and tool execution paths.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, LangSmith SDK, Zod, Claude Agent SDK (dependency only; not used to replace the current provider runtime).

---

## File Structure

- Create: `packages/observability-langsmith/package.json` — package metadata and isolated external dependencies.
- Create: `packages/observability-langsmith/tsconfig.json` — package typecheck configuration.
- Create: `packages/observability-langsmith/src/index.ts` — exported tracer interfaces, environment parsing, no-op tracer, and LangSmith adapter.
- Create: `packages/observability-langsmith/src/index.test.ts` — unit tests for config, redaction, terminal states, and failure isolation.
- Modify: `tsconfig.base.json` — `@helios/observability-langsmith` path alias.
- Modify: `packages/kernel/package.json` — workspace dependency on the adapter package.
- Modify: `packages/kernel/src/kernel.ts` — optional `tracer` in `KernelOptions`, environment default, and forwarding to Session.
- Modify: `packages/kernel/src/session.ts` — accept and forward the tracer to `runTurnLoop` dependencies.
- Modify: `packages/kernel/src/agentLoop/types.ts` — add a tracer to loop dependencies.
- Modify: `packages/kernel/src/agentLoop/runTurnLoop.ts` — create/finish root and LLM child runs.
- Modify: `packages/kernel/src/agentLoop/executeTools.ts` — create/finish one child tool run per tool invocation.
- Modify: `packages/kernel/test/agent-loop-fixes.test.ts` — integration assertions for root/LLM/tool hierarchy and cancellation/failure terminal states.
- Create: `.env.example` — safe LangSmith environment-variable template.
- Create: `.gitignore` — ignore real environment files while retaining `.env.example`.
- Modify: `README.md` — secure configuration and trace-tree documentation.
- Modify: `pnpm-lock.yaml` — resolved dependencies after package installation.

### Task 1: Define and test the tracing adapter contract

**Files:**
- Create: `packages/observability-langsmith/src/index.test.ts`
- Create: `packages/observability-langsmith/package.json`
- Create: `packages/observability-langsmith/tsconfig.json`

- [ ] **Step 1: Write failing tests for disabled configuration and data redaction**

```ts
import { describe, expect, it, vi } from "vitest";
import { createLangSmithTracer, type TraceInput } from "./index";

describe("createLangSmithTracer", () => {
  it("returns a no-op tracer when tracing is disabled or the key is absent", async () => {
    const tracer = createLangSmithTracer({ LANGSMITH_TRACING: "false" });
    const run = tracer.startRun({ name: "helios.agent_turn", runType: "chain" });
    await expect(run.end({ status: "success" })).resolves.toBeUndefined();
  });

  it("redacts secrets and truncates oversized values before the SDK receives them", async () => {
    const createRun = vi.fn().mockResolvedValue(undefined);
    const tracer = createLangSmithTracer(
      { LANGSMITH_TRACING: "true", LANGSMITH_API_KEY: "key", LANGSMITH_PROJECT: "helios" },
      { client: { createRun, updateRun: vi.fn().mockResolvedValue(undefined) } },
    );
    tracer.startRun({
      name: "helios.tool.fetch",
      runType: "tool",
      input: { Authorization: "Bearer secret", body: "x".repeat(20_000) },
    });
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
      inputs: { Authorization: "[REDACTED]", body: expect.stringMatching(/…$/) },
    }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/observability-langsmith/src/index.test.ts`
Expected: FAIL because the package and `createLangSmithTracer` do not exist.

- [ ] **Step 3: Add the package metadata and TypeScript config**

Create `packages/observability-langsmith/package.json`:

```json
{
  "name": "@helios/observability-langsmith",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "langsmith": "^0.3.0",
    "zod": "^3.25.76"
  }
}
```

Create `packages/observability-langsmith/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Use the versions resolved by `pnpm add --filter @helios/observability-langsmith @anthropic-ai/claude-agent-sdk langsmith zod`; do not manually edit `pnpm-lock.yaml`.

- [ ] **Step 4: Implement the stable adapter API and no-op implementation**

Create `packages/observability-langsmith/src/index.ts` with these exported contracts and behavior:

```ts
export type TraceRunType = "chain" | "llm" | "tool";
export type TraceStatus = "success" | "error" | "cancelled";
export interface TraceInput {
  name: string;
  runType: TraceRunType;
  input?: unknown;
  metadata?: Record<string, unknown>;
}
export interface TraceResult { status: TraceStatus; output?: unknown; error?: unknown; }
export interface TraceRun {
  startChild(input: TraceInput): TraceRun;
  end(result: TraceResult): Promise<void>;
}
export interface Tracer { startRun(input: TraceInput): TraceRun; }

export function createLangSmithTracer(
  env: NodeJS.ProcessEnv = process.env,
  deps?: { client?: Pick<Client, "createRun" | "updateRun">; now?: () => Date },
): Tracer;
```

Parse `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, and `LANGSMITH_PROJECT` with Zod. Return a no-op tracer unless tracing is exactly enabled and an API key exists. Use a random UUID for each run, give child runs the parent ID, call `createRun` synchronously without awaiting it, and make `end()` call `updateRun` with `end_time`, outputs/error and `extra.metadata.status`. Attach a catch handler to every SDK promise so tracing exceptions never reject the Agent path. Recursively redact case-insensitive keys containing `api_key`, `authorization`, `cookie`, `password`, `secret`, or `token`; cap strings at 8,192 characters and arrays/objects at 100 entries.

- [ ] **Step 5: Run the adapter tests and typecheck**

Run: `pnpm exec vitest run packages/observability-langsmith/src/index.test.ts && pnpm --filter @helios/observability-langsmith typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the isolated adapter**

```bash
git add packages/observability-langsmith tsconfig.base.json pnpm-lock.yaml
git commit -m "feat: add LangSmith tracing adapter"
```

### Task 2: Add the adapter path alias and package installation

**Files:**
- Modify: `tsconfig.base.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write a failing import check in the adapter test**

Add this assertion to `packages/observability-langsmith/src/index.test.ts`:

```ts
import { createLangSmithTracer } from "@helios/observability-langsmith";

it("exports the workspace package entry point", () => {
  expect(typeof createLangSmithTracer).toBe("function");
});
```

- [ ] **Step 2: Run it to verify alias resolution fails**

Run: `pnpm exec vitest run packages/observability-langsmith/src/index.test.ts`
Expected: FAIL with unresolved `@helios/observability-langsmith`.

- [ ] **Step 3: Register the path alias and install requested dependencies**

Add this exact entry under `compilerOptions.paths` in `tsconfig.base.json`:

```json
"@helios/observability-langsmith": ["./packages/observability-langsmith/src/index.ts"]
```

Run the workspace-aware install command:

```bash
pnpm --filter @helios/observability-langsmith add @anthropic-ai/claude-agent-sdk langsmith zod
```

Do not use `npm install` in this pnpm workspace. Confirm the lockfile contains all three direct dependencies and no source file imports the Claude Agent SDK in this change.

- [ ] **Step 4: Verify the package resolves and lockfile is valid**

Run: `pnpm exec vitest run packages/observability-langsmith/src/index.test.ts && pnpm install --lockfile-only --offline`
Expected: PASS; the offline lockfile validation exits 0.

- [ ] **Step 5: Commit package registration**

```bash
git add tsconfig.base.json packages/observability-langsmith/package.json pnpm-lock.yaml
git commit -m "chore: register LangSmith workspace package"
```

### Task 3: Inject tracing into Kernel, turns, and LLM stream attempts

**Files:**
- Modify: `packages/kernel/package.json`
- Modify: `packages/kernel/src/kernel.ts`
- Modify: `packages/kernel/src/session.ts`
- Modify: `packages/kernel/src/agentLoop/types.ts`
- Modify: `packages/kernel/src/agentLoop/runTurnLoop.ts`
- Modify: `packages/kernel/test/agent-loop-fixes.test.ts`

- [ ] **Step 1: Write a failing run-tree integration test**

Add an in-memory tracer to `packages/kernel/test/agent-loop-fixes.test.ts`:

```ts
class RecordingTracer implements Tracer {
  readonly runs: Array<{ name: string; runType: string; parent?: string; result?: TraceResult }> = [];
  startRun(input: TraceInput): TraceRun {
    return this.create(input, undefined);
  }
  private create(input: TraceInput, parent: string | undefined): TraceRun {
    const record = { id: String(this.runs.length), name: input.name, runType: input.runType, parent };
    this.runs.push(record);
    return { startChild: (child) => this.create(child, record.id), end: async (result) => { record.result = result; } };
  }
}

it("records an agent root and an llm child for a normal turn", async () => {
  const tracer = new RecordingTracer();
  const { session } = await bootSession("mockLlmEmpty.ts", [], undefined, { tracer });
  await session.sendMessage("hi");
  expect(tracer.runs).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "helios.agent_turn", runType: "chain", result: { status: "success" } }),
    expect.objectContaining({ name: "helios.llm.stream", runType: "llm", parent: "0", result: { status: "success" } }),
  ]));
});
```

Extend `bootSession` to take `tracer?: Tracer` and pass it into `new Kernel({ ..., tracer })`.

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `pnpm exec vitest run packages/kernel/test/agent-loop-fixes.test.ts -t "records an agent root"`
Expected: FAIL because `KernelOptions` has no `tracer` field and no runs are started.

- [ ] **Step 3: Wire the interface through Kernel and Session**

Add `"@helios/observability-langsmith": "workspace:*"` to `packages/kernel/package.json`. Import `Tracer`, `TraceRun`, and `createLangSmithTracer` as types/factory in `kernel.ts`. Add `tracer?: Tracer` to `KernelOptions`, store `this.tracer = opts.tracer ?? createLangSmithTracer()`, add `tracer: this.tracer` to the `Session` constructor options, and add the same required property to `SessionOptions` and `RunLoopDeps`.

In `runTurnLoop`, start the root once before `dispatchRunStart`:

```ts
const trace = deps.tracer.startRun({
  name: "helios.agent_turn",
  runType: "chain",
  input: params.pendingLeadMessages,
  metadata: { sessionId, runId, provider: provider.id, model: llmOptions.model ?? "" },
});
let traceStatus: TraceStatus = "success";
let traceError: unknown;
try {
  // existing loop body and existing return result
} catch (error) {
  traceStatus = signal.aborted ? "cancelled" : "error";
  traceError = error;
  throw error;
} finally {
  if (signal.aborted) traceStatus = "cancelled";
  await trace.end({ status: traceStatus, output: { turnIds, runError }, error: traceError ?? runError });
}
```

Around each `streamAssistant` attempt, create `const llmTrace = trace.startChild({ name: "helios.llm.stream", runType: "llm", input: { messages: path, tools: toolRegistry.list(), options: effective }, metadata: { provider: usedProvider.id, turnId, retryCount } })`; in `finally`, call `llmTrace.end` with status `cancelled`, `error`, or `success`, plus `{ stopReason, usage }` when a stream result exists. This produces one LLM child per retry attempt and never changes retry behavior.

- [ ] **Step 4: Run the Kernel test to verify it passes**

Run: `pnpm exec vitest run packages/kernel/test/agent-loop-fixes.test.ts -t "records an agent root"`
Expected: PASS.

- [ ] **Step 5: Add and pass failure/cancellation terminal-state tests**

Add two tests that reuse `RecordingTracer`:

```ts
it("ends the root trace as error when an unexpected LLM failure escapes", async () => {
  // boot fixture that throws TypeError; assert sendMessage rejects and root.result.status is "error".
});

it("ends the root trace as cancelled when the session signal aborts", async () => {
  // start a blocking fixture, call session.cancel(), then assert root.result.status is "cancelled".
});
```

Run: `pnpm exec vitest run packages/kernel/test/agent-loop-fixes.test.ts`
Expected: PASS with existing loop behavior unchanged.

- [ ] **Step 6: Commit Kernel and LLM tracing**

```bash
git add packages/kernel/package.json packages/kernel/src/kernel.ts packages/kernel/src/session.ts packages/kernel/src/agentLoop/types.ts packages/kernel/src/agentLoop/runTurnLoop.ts packages/kernel/test/agent-loop-fixes.test.ts pnpm-lock.yaml
git commit -m "feat: trace Helios agent and LLM runs"
```

### Task 4: Trace each tool invocation without changing tool execution semantics

**Files:**
- Modify: `packages/kernel/src/agentLoop/executeTools.ts`
- Modify: `packages/kernel/src/agentLoop/runTurnLoop.ts`
- Modify: `packages/kernel/test/agent-loop-fixes.test.ts`

- [ ] **Step 1: Write a failing hierarchy test for a tool-using run**

```ts
it("records each tool invocation beneath its agent turn", async () => {
  const tracer = new RecordingTracer();
  const { session } = await bootSession(
    "mockLlmParallel.ts",
    [{ port: "CapabilityProvider", package: fixture("mockCapabilityParallel.ts") }],
    undefined,
    { tracer },
  );
  await session.sendMessage("go");
  expect(tracer.runs.filter((run) => run.runType === "tool")).toEqual([
    expect.objectContaining({ name: "helios.tool.toolA", result: expect.objectContaining({ status: "success" }) }),
    expect.objectContaining({ name: "helios.tool.toolB", result: expect.objectContaining({ status: "success" }) }),
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/kernel/test/agent-loop-fixes.test.ts -t "records each tool invocation"`
Expected: FAIL because `executeTools` does not accept a parent trace.

- [ ] **Step 3: Pass the root trace to tool execution and close every tool run**

Add `trace: TraceRun` to `ExecuteToolsParams` and `ToolExecCtx`; pass `trace` from the current root in `runTurnLoop`. At the first line of `runOneToolCall`, create:

```ts
const toolTrace = ctx.trace.startChild({
  name: `helios.tool.${block.name}`,
  runType: "tool",
  input: block.input,
  metadata: { sessionId, turnId: block.id, toolUseId: block.id },
});
```

Move the body into `try/finally`. Keep all existing early `return finish()` paths, but make `finish()` call `await toolTrace.end({ status: isError ? "error" : toolCtx.signal.aborted ? "cancelled" : "success", output: { output, isError, cacheHit, executed } })` after emitting the existing tool-end event and runtime dispatch. In a catch path, preserve the existing tool result behavior, set `isError = true`, and end the trace with the caught error. Do not include `workDir`, raw files, or unbounded output in metadata.

- [ ] **Step 4: Run tool hierarchy and regression tests**

Run: `pnpm exec vitest run packages/kernel/test/agent-loop-fixes.test.ts`
Expected: PASS; existing parallel ordering, hooks, cache, and mutation audit tests remain unchanged.

- [ ] **Step 5: Commit tool tracing**

```bash
git add packages/kernel/src/agentLoop/executeTools.ts packages/kernel/src/agentLoop/runTurnLoop.ts packages/kernel/test/agent-loop-fixes.test.ts
git commit -m "feat: trace Helios tool invocations"
```

### Task 5: Provide safe configuration and perform full verification

**Files:**
- Create: `.env.example`
- Create: `.gitignore`
- Modify: `README.md`

- [ ] **Step 1: Write a failing documentation/configuration check**

Run:

```bash
test -f .env.example
test -f .gitignore
rg -n '^LANGSMITH_API_KEY=$|^\.env$|^\.env\.\*$|LANGSMITH_TRACING' .env.example .gitignore README.md
```

Expected: FAIL because the secure template and ignore rules do not exist.

- [ ] **Step 2: Add the environment template and ignores**

Create `.env.example`:

```bash
# Copy to .env locally; never commit a real LangSmith API key.
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=helios
```

Create `.gitignore`:

```gitignore
.env
.env.*
!.env.example
node_modules/
dist/
```

Preserve any existing ignore entries if a `.gitignore` appears while executing the plan.

- [ ] **Step 3: Document setup and behavior in README**

Add a `## LangSmith 可观测性` section after installation. Include the `cp .env.example .env` workflow, state that variables must be available to CLI/Electron main/Web host processes, explain the root/LLM/tool run hierarchy, state that tracing is optional and non-blocking, and advise rotating any key pasted into chats or logs. Do not include a live key.

- [ ] **Step 4: Run targeted checks and the full suite**

Run:

```bash
pnpm --filter @helios/observability-langsmith typecheck
pnpm --filter @helios/kernel typecheck
pnpm exec vitest run packages/observability-langsmith/src/index.test.ts packages/kernel/test/agent-loop-fixes.test.ts
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Expected: all commands exit 0; only intended source, dependency, config, documentation, and test changes remain.

- [ ] **Step 5: Commit final configuration and documentation**

```bash
git add .env.example .gitignore README.md
git commit -m "docs: document LangSmith tracing setup"
```

## Plan self-review

- Spec coverage: Tasks 1-2 implement the isolated adapter, environment configuration, requested dependencies, no-op fallback, and redaction; Task 3 implements root and LLM runs plus terminal-state handling; Task 4 implements tool spans; Task 5 supplies secure setup and verifies the full change.
- No placeholders: all package names, file paths, test commands, interfaces, terminal states, redaction policy, and configuration values are explicit.
- Type consistency: `Tracer`, `TraceRun`, `TraceInput`, `TraceResult`, and `TraceStatus` are defined in Task 1 and used consistently by Tasks 3-4.
