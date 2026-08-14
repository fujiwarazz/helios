# Pi TUI for Helios CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Helios CLI's interactive mode with Pi-derived terminal UI components while retaining Helios Kernel and its manifest-loaded ports as the only agent runtime.

**Architecture:** Create a framework-only `@helios/tui` package from Pi's independent TUI source. Add a small CLI-local adapter that projects `Session` history/events into transcript state, owns input/cancel/approval interactions, and renders through that package. The existing plain renderer remains for `--message` and non-TTY execution.

**Tech Stack:** TypeScript, pnpm workspace, Vitest, Node terminal streams, Pi TUI source under `/Users/zhangzihao/Desktop/codes/pi` (MIT).

---

## File structure

- `packages/tui/**`: framework-only Pi TUI source and its package metadata; no Helios imports.
- `packages/tui/UPSTREAM_NOTICE.md`: copied-source provenance and MIT attribution.
- `apps/cli/src/tui/sessionViewModel.ts`: deterministic conversion from `Message`/`AgentEvent` to renderable transcript state.
- `apps/cli/src/tui/approvalOverlay.ts`: focused choice overlay and the `AskQuestionResponse` bridge.
- `apps/cli/src/tui/interactiveCli.ts`: terminal lifecycle, input dispatch, Session subscription, and TUI component composition.
- `apps/cli/src/tui/plainCli.ts`: extracted current `readline` interaction used for non-TTY and one-shot messages.
- `apps/cli/src/interactiveMode.ts`: pure mode-selection predicate used by entrypoint tests.
- `apps/cli/src/index.ts`: selects the TUI or plain path after workspace creation.

## Task 1: Add the standalone `@helios/tui` package

**Files:**
- Create: `packages/tui/package.json`
- Create: `packages/tui/tsconfig.json`
- Create: `packages/tui/UPSTREAM_NOTICE.md`
- Create: `packages/tui/src/**` copied from `/Users/zhangzihao/Desktop/codes/pi/packages/tui/src/**`
- Modify: `package.json`
- Modify: `tsconfig.base.json`
- Modify: `vitest.config.ts`
- Modify: `apps/cli/package.json`

- [ ] **Step 1: Add a package-resolution test that imports the future public surface**

Create `packages/tui/src/index.test.ts` before the package source exists:

```ts
import { describe, expect, it } from "vitest";
import { Container, Text } from "./index";

describe("@helios/tui", () => {
  it("renders framework components without Helios runtime imports", () => {
    const container = new Container();
    container.addChild(new Text("helios"));
    expect(container.render(80)).toEqual(["helios"]);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails because the package does not exist**

Run: `pnpm vitest run packages/tui/src/index.test.ts`

Expected: FAIL with a module-resolution error for `./index`.

- [ ] **Step 3: Create package metadata, attribution, and copy the independent Pi TUI source**

Use these exact package definitions (preserve the two direct runtime dependencies at the versions used by the checked-out Pi source):

```json
{
  "name": "@helios/tui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "get-east-asian-width": "1.6.0",
    "marked": "18.0.5"
  }
}
```

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"]
}
```

Copy every file in Pi's `packages/tui/src/` into `packages/tui/src/` unchanged first. Add `UPSTREAM_NOTICE.md` containing the Pi repository path/revision `936aff009`, the MIT copyright line `Copyright (c) 2025 Mario Zechner`, and the full MIT license text. Do not copy Pi `coding-agent` files or native build artifacts. Update the root workspace scripts/paths and `vitest.config.ts` alias with `@helios/tui`, then add `@helios/tui: workspace:*` to `apps/cli/package.json`.

- [ ] **Step 4: Install the exact package dependencies without lifecycle scripts**

Run: `pnpm install --ignore-scripts`

Expected: `pnpm-lock.yaml` gains only `get-east-asian-width@1.6.0` and `marked@18.0.5` dependency resolution required by `@helios/tui`.

- [ ] **Step 5: Run the focused test and TUI package type check**

Run:

```bash
pnpm vitest run packages/tui/src/index.test.ts
pnpm --filter @helios/tui typecheck
```

Expected: PASS. The public Pi-derived primitives compile under Helios's TypeScript configuration and the test renders `helios`.

## Task 2: Build the event-to-view-model boundary

**Files:**
- Create: `apps/cli/src/tui/sessionViewModel.test.ts`
- Create: `apps/cli/src/tui/sessionViewModel.ts`

- [ ] **Step 1: Write failing view-model tests using real Helios event shapes**

Create tests that specify the public API:

```ts
const model = new SessionViewModel();
model.hydrate([{ id: "u1", role: "user", content: "hello" }]);
model.apply({ type: "message_start", messageId: "a1", role: "assistant", turnId: "t1" });
model.apply({ type: "message_update", messageId: "a1", delta: { type: "text-delta", text: "Hi" } });
model.apply({ type: "message_update", messageId: "a1", delta: { type: "thinking-delta", text: "reason" } });

expect(model.snapshot().messages).toEqual([
  { id: "u1", role: "user", text: "hello", thinking: "", complete: true },
  { id: "a1", role: "assistant", text: "Hi", thinking: "reason", complete: false },
]);
```

Add separate tests for: `tool_execution_start` then `tool_execution_end` error state; `llm_retry` status; `agent_end` clears busy state; and `hydrate()` converting `ContentBlock[]` into text, thinking, and tool summaries without using `getHistory()`.

- [ ] **Step 2: Run the test to verify the module is missing**

Run: `pnpm vitest run apps/cli/src/tui/sessionViewModel.test.ts`

Expected: FAIL with `Failed to load url ./sessionViewModel`.

- [ ] **Step 3: Implement the smallest explicit view-model API**

Implement these exported types and methods:

```ts
export interface TranscriptMessage {
  id: string;
  role: Message["role"];
  text: string;
  thinking: string;
  complete: boolean;
}

export interface ToolCardState {
  toolUseId: string;
  name: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  status: "pending" | "running" | "success" | "error";
  descriptor?: ToolRenderDescriptor;
}

export class SessionViewModel {
  hydrate(history: readonly Message[]): void;
  apply(event: AgentEvent): void;
  snapshot(): Readonly<SessionViewState>;
}
```

Keep mutable maps private, return copied arrays from `snapshot()`, append only text/thinking deltas to the currently identified `messageId`, and ignore signature/tool-delta events that have no first-release visual representation. Use a private `renderValue(value: unknown)` that returns strings unchanged and otherwise calls `JSON.stringify` with a `String(value)` fallback for circular/undefined values.

- [ ] **Step 4: Run view-model tests to verify green**

Run: `pnpm vitest run apps/cli/src/tui/sessionViewModel.test.ts`

Expected: PASS for history hydration, streaming accumulation, tool status, retry, and end-of-run state.

## Task 3: Implement approval and transcript presentation components

**Files:**
- Create: `apps/cli/src/tui/approvalOverlay.test.ts`
- Create: `apps/cli/src/tui/approvalOverlay.ts`
- Create: `apps/cli/src/tui/transcript.ts`
- Create: `apps/cli/src/tui/toolCard.ts`

- [ ] **Step 1: Write a failing approval test against a fake `TUI` overlay host**

The test should call the public bridge and simulate selection/cancellation through injected callbacks:

```ts
const overlay = new FakeOverlayHost();
const response = askApproval(overlay, {
  question: "Proceed?",
  options: [{ label: "Allow" }, { label: "Deny" }],
});

overlay.choose("Deny");
await expect(response).resolves.toEqual({ answers: ["Deny"] });

const cancelled = askApproval(overlay, { question: "Proceed?" });
overlay.cancel();
await expect(cancelled).resolves.toEqual({ answers: [] });
```

- [ ] **Step 2: Run the approval test to verify red**

Run: `pnpm vitest run apps/cli/src/tui/approvalOverlay.test.ts`

Expected: FAIL because `askApproval` is not exported.

- [ ] **Step 3: Implement the presentation layer with Pi-derived primitives**

Implement `ApprovalOverlayHost` with the minimum methods required by `askApproval`, then adapt a real `TUI` with `SelectList`, `Text`, `Container`, and `showOverlay()`. `askApproval()` must settle once, hide the overlay after selection, and resolve `{ answers: [] }` for escape/cancel. Implement `Transcript` as a `Container` that replaces/updates a `Markdown` or `Text` child for each `TranscriptMessage`; implement `ToolCard` with a `Text` child derived only from `ToolCardState` and never from a Port object.

- [ ] **Step 4: Run approval tests and TUI typecheck**

Run:

```bash
pnpm vitest run apps/cli/src/tui/approvalOverlay.test.ts
pnpm --filter @helios/cli typecheck
```

Expected: PASS. An approval prompt can be settled once with a selected option or no answer.

## Task 4: Build and test the interactive Session controller

**Files:**
- Create: `apps/cli/src/tui/interactiveCli.test.ts`
- Create: `apps/cli/src/tui/interactiveCli.ts`

- [ ] **Step 1: Write failing controller tests using a fake session facade and fake TUI view**

Define only the required facade in the test:

```ts
const session = new FakeSession([{ id: "u1", role: "user", content: "saved" }]);
const view = new FakeInteractiveView();
const controller = new InteractiveCli({ session, view });

await controller.start();
expect(view.state.messages[0]?.text).toBe("saved");
view.submit("new prompt");
expect(session.sent).toEqual(["new prompt"]);
view.pressCtrlC();
expect(session.cancelled).toBe(1);
```

Add tests that the event listener is disposed on stop, a second submit while `busy` does not call `sendMessage`, a rejected send is rendered as an error status, and `askQuestion()` delegates to `askApproval()`.

- [ ] **Step 2: Run the controller test to verify red**

Run: `pnpm vitest run apps/cli/src/tui/interactiveCli.test.ts`

Expected: FAIL with a missing `InteractiveCli` module/export.

- [ ] **Step 3: Implement the controller and real Pi-TUI view**

Use this narrow contract rather than importing `Session` throughout component files:

```ts
export interface InteractiveSession {
  getDisplayHistory(): Message[];
  on(listener: (event: AgentEvent) => void): () => void;
  sendMessage(text: string): Promise<Message[]>;
  cancel(): void;
}

export interface InteractiveView {
  start(state: SessionViewState): void;
  update(state: SessionViewState): void;
  stop(): Promise<void>;
  onSubmit(handler: (text: string) => void): void;
  onCancel(handler: () => void): void;
  askQuestion(request: AskQuestionRequest): Promise<AskQuestionResponse>;
}
```

`InteractiveCli.start()` hydrates the view model from `getDisplayHistory()`, subscribes before accepting input, sets `busy` from event state, and serializes `sendMessage()` completion. The real `HeliosInteractiveView` owns `ProcessTerminal`, `TuiMainScreen`, `Editor`, transcript, status text, and focused overlays. It binds Ctrl+C to `session.cancel()` without exiting; Ctrl+D or an explicit `/quit` input must call the controller's `stop()` path so `TUI.stop()` restores raw terminal state.

- [ ] **Step 4: Run controller tests to verify green**

Run: `pnpm vitest run apps/cli/src/tui/interactiveCli.test.ts`

Expected: PASS for hydration, submission, busy protection, cancellation, approval delegation, error rendering, and cleanup.

## Task 5: Route the CLI between TUI and plain output

**Files:**
- Create: `apps/cli/src/interactiveMode.test.ts`
- Create: `apps/cli/src/interactiveMode.ts`
- Create: `apps/cli/src/tui/plainCli.ts`
- Modify: `apps/cli/src/index.ts:1-175`

- [ ] **Step 1: Write mode-selection tests first**

Create a pure predicate test:

```ts
expect(selectInteractiveMode({ hasMessage: false, stdinIsTTY: true, stdoutIsTTY: true })).toBe("tui");
expect(selectInteractiveMode({ hasMessage: true, stdinIsTTY: true, stdoutIsTTY: true })).toBe("plain");
expect(selectInteractiveMode({ hasMessage: false, stdinIsTTY: false, stdoutIsTTY: true })).toBe("plain");
expect(selectInteractiveMode({ hasMessage: false, stdinIsTTY: true, stdoutIsTTY: false })).toBe("plain");
```

- [ ] **Step 2: Run the selection test to verify red**

Run: `pnpm vitest run apps/cli/src/interactiveMode.test.ts`

Expected: FAIL with missing `selectInteractiveMode`.

- [ ] **Step 3: Extract the current plain path and wire TUI mode**

Move current `readline`, `render()`, `formatError()`, and one-shot-message behavior into `plainCli.ts`. In `index.ts`, create the `askQuestion` callback as a mutable dispatch function: before TUI starts it uses plain readline; after `HeliosInteractiveView` is constructed it delegates to `view.askQuestion(request)`. Pass that callback unchanged into `openCliWorkspace()` so ports and Kernel retain their existing construction path. After obtaining `BoundSession`, call `selectInteractiveMode()`; use `InteractiveCli` only for the interactive-TTY branch and retain all current `--message` output/status lines for plain mode.

- [ ] **Step 4: Run selection and existing CLI tests**

Run:

```bash
pnpm vitest run apps/cli/src/interactiveMode.test.ts apps/cli/test/cli.e2e.test.ts
pnpm --filter @helios/cli typecheck
```

Expected: PASS. Existing spawned `--message` tests remain non-interactive and retain their stdout expectations.

## Task 6: Verify port independence, workspace checks, and terminal behavior

**Files:**
- Modify: `apps/cli/src/tui/interactiveCli.test.ts`
- Modify: `apps/cli/test/cli.e2e.test.ts`
- Modify: `README.md` only if the CLI documentation has an interactive-mode section that must state TTY fallback behavior.

- [ ] **Step 1: Write a failing generic-tool regression test**

Add a test that drives a fake event stream with a tool name that is not hard-coded in the UI:

```ts
session.emit({
  type: "tool_execution_start",
  toolUseId: "tool-1",
  name: "plugin__custom_search",
  input: { query: "helios" },
});
session.emit({
  type: "tool_execution_end",
  toolUseId: "tool-1",
  output: { count: 2 },
  isError: false,
});

expect(view.state.tools).toContainEqual(expect.objectContaining({
  name: "plugin__custom_search",
  status: "success",
}));
```

- [ ] **Step 2: Run the regression test to verify red**

Run: `pnpm vitest run apps/cli/src/tui/interactiveCli.test.ts`

Expected: FAIL until the controller forwards tool events through `SessionViewModel` to the view.

- [ ] **Step 3: Make the minimum generic rendering correction**

Ensure the event path never switches on known Port or tool names. On `tool_execution_end`, use an event-provided `descriptor` when present; otherwise render the recorded name/input/output generic state. Do not add imports from concrete Port packages.

- [ ] **Step 4: Run focused tests, workspace type checks, and manual tmux smoke test**

Run:

```bash
pnpm vitest run packages/tui/src/index.test.ts apps/cli/src/tui/sessionViewModel.test.ts apps/cli/src/tui/approvalOverlay.test.ts apps/cli/src/tui/interactiveCli.test.ts apps/cli/src/interactiveMode.test.ts apps/cli/test/cli.e2e.test.ts
pnpm --filter @helios/tui typecheck
pnpm --filter @helios/cli typecheck
pnpm typecheck
```

Then start a controlled terminal, submit one message with a local/mock manifest, press Ctrl+C during a running request, and quit:

```bash
tmux new-session -d -s helios-tui-smoke -x 100 -y 32
tmux send-keys -t helios-tui-smoke "pnpm --filter @helios/cli start" Enter
tmux capture-pane -t helios-tui-smoke -p
tmux send-keys -t helios-tui-smoke "hello" Enter
tmux send-keys -t helios-tui-smoke C-c
tmux send-keys -t helios-tui-smoke C-d
tmux kill-session -t helios-tui-smoke
```

Expected: all tests/type checks pass; the terminal exits with cursor/raw mode restored; a previously unknown Port tool reaches a successful generic tool card.

## Plan self-review

- **Spec coverage:** Task 1 covers Pi code provenance and framework isolation. Tasks 2–4 cover direct Helios event consumption, history, stream rendering, cancellation, and approvals. Tasks 5–6 preserve plain mode and demonstrate Port-independent rendering.
- **No hidden second runtime:** no task imports `@earendil-works/pi-coding-agent`, Pi RPC types, or Pi `AgentSession`; only the independent TUI source is copied.
- **Type consistency:** `SessionViewModel` is the only raw `AgentEvent` consumer; `InteractiveCli` receives `InteractiveSession`; all UI components receive view state or narrow callbacks.
