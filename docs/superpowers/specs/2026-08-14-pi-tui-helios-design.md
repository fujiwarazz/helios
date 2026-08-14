# Pi TUI for Helios CLI — Design

## Goal

Replace the interactive `readline` loop in `@helios/cli` with a Pi-derived terminal UI while preserving Helios Kernel as the sole owner of sessions, workspaces, ports, tools, persistence, and agent execution.

## Scope

The first release provides:

- Pi's terminal UI foundation: terminal lifecycle, differential rendering, input editor, Markdown, containers, overlays, and keyboard handling.
- A Helios-specific interactive view with streaming transcript, generic tool cards, Ctrl+C cancellation, approval selection overlays, and restored display history.
- TUI by default only when stdin and stdout are TTYs; `--message` and non-TTY execution retain the existing plain-output behavior.

It does not import Pi's coding-agent `AgentSession`, model/auth runtime, extension system, session manager/tree, Pi RPC protocol, or Pi-specific slash commands.

## Package boundaries

### `packages/tui`

Create `@helios/tui` from Pi's independent `packages/tui/src` source. Preserve the upstream MIT copyright and license notice in the copied source/package metadata. This package is a terminal rendering framework only; it must not import `@helios/kernel`, `@helios/ports`, or any Helios runtime package.

### `apps/cli/src/tui`

Add the Helios-specific integration layer beside the CLI entrypoint:

- `interactiveCli.ts` owns terminal startup/shutdown and binds an already-created `BoundSession`.
- `sessionViewModel.ts` maps Helios `AgentEvent` and restored `Message` objects into UI-owned transcript and tool-card state.
- `approvalOverlay.ts` presents `AskQuestionRequest` choices and resolves the existing `askQuestion` callback.
- Small focused presentation components render transcript messages, streaming text, tool cards, status, and the input editor using `@helios/tui` primitives.

The view layer may depend on `@helios/kernel` types and `@helios/ports` request types. Pi-derived TUI primitives remain framework-only.

## Runtime data flow

`openCliWorkspace()` continues to load the manifest, create/resume the workspace-bound session, and load all configured ports. The interactive CLI then receives `BoundSession` and directly subscribes to `bound.session.on()`.

```text
Editor submit ───────> Session.sendMessage(text)
Ctrl+C ──────────────> Session.cancel()
AskQuestionRequest ─> Approval overlay ─> AskQuestionResponse

Session.getDisplayHistory() ─> initial transcript
Session.on(AgentEvent) ──────> sessionViewModel ─> Pi-derived TUI components
```

No local CLI request crosses `@helios/protocol`; that package remains the transport boundary for Electron, WebSocket, and other remote consumers. The direct subscription avoids JSON serialization, RPC request lifetime differences, reconnect behavior, and duplicate session state.

## Event consumption and compatibility

`sessionViewModel` is the only location that consumes raw `AgentEvent`. It maps:

- `message_start`, `message_update`, and `message_end` into user/assistant streaming transcript entries. Text and thinking deltas are accumulated in the active message.
- `tool_execution_start` and `tool_execution_end` into generic tool-card states keyed by `toolUseId`.
- `llm_retry`, compaction, rollback, and `agent_end` into transient status or terminal transcript state.
- unknown/non-visual events into no UI update.

The TUI uses `getDisplayHistory()` for restoration rather than the compressed LLM context returned by `getHistory()`.

This adapter isolates Kernel changes: an `AgentEvent` field or variant change produces a compile-time failure at the mapping boundary rather than changes throughout UI components. A new port needs no UI change: any registered tool is rendered through the generic event path. If an event carries a `ToolRenderDescriptor`, the card prefers its label, status, and detail; otherwise it shows the tool name, result/error state, and a safely stringified summary.

## Interaction rules and error handling

- Raw-mode input starts only after workspace/session creation succeeds.
- The editor is disabled while a submission is active in the first release. A later queue/steering policy remains a Helios-specific feature.
- Ctrl+C cancels the active session run. A subsequent exit action restores the terminal before disposing the workspace runtime.
- `AskQuestionRequest` is rendered as a focused select overlay; selection resolves the callback with the selected label. Closing the overlay resolves `{ answers: [] }` so the tool can handle an explicit no-answer result.
- TUI initialization/render failure stops the renderer and restores terminal state before reporting the error through stderr.
- The existing `readline` renderer remains the fallback for `--message` and non-TTY streams so scripts keep receiving only ordinary stdout text.

## Testing

Use test-first development.

1. Unit-test the view model with real `AgentEvent` fixtures: restored history, streaming text accumulation, thinking deltas, tool start/end, error result, retry state, and completion.
2. Unit-test input bindings with a fake session facade: submit calls `sendMessage`, Ctrl+C calls `cancel`, and no second send starts while busy.
3. Unit-test approval overlay adaptation: an option click resolves the expected `AskQuestionResponse`; cancellation has a defined response.
4. Add a CLI-level test proving TTY mode selects the TUI entrypoint while `--message`/non-TTY retain plain mode, using injectable terminal/session seams rather than an actual terminal.
5. Run package type checks and targeted tests. Manually smoke-test in tmux to verify raw-mode cleanup after cancellation and exit.

## Acceptance criteria

- An interactive `helios` terminal starts the new TUI and displays restored history.
- User input streams Helios assistant output without a second agent or session implementation.
- Tool execution displays start and final success/error state for any Port-provided tool.
- Ctrl+C invokes `Session.cancel()` and the terminal is restored on shutdown or failure.
- `AskQuestion` tools are answered through a selectable TUI overlay.
- Port loading remains controlled solely by the existing manifest/workspace runtime.
- `helios --message ...` and non-interactive output retain current plain-text semantics.
