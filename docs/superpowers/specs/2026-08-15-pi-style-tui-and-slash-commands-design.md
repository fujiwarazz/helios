# Pi-style Helios TUI and slash commands — Design

## Goal

Make the interactive Helios CLI feel like Pi while keeping Helios Kernel as the only owner of agent execution, ports, persistence, sessions, and the message tree. The TUI must consume the existing Kernel event stream directly; Pi's `AgentSession`, model runtime, RPC protocol, tools, and session implementation remain out of scope.

The release also adds local slash-command routing, including real in-process switching between persisted sessions and existing Kernel message-tree branches.

## Scope

### Included

- A persistent, Pi-derived component tree for transcript rendering instead of clearing and rebuilding all terminal text for every event.
- Incremental Markdown rendering for assistant text, including fenced code blocks and syntax-aware styling supported by `@helios/tui`.
- A muted, collapsible thinking area when `thinking-delta` events are present. No thinking placeholder is rendered for models that do not emit those events.
- Generic compact tool cards that show tool label/name plus running, success, or error state. Inputs and output bodies are not expanded by default. A `ToolRenderDescriptor`, when present, supplies the preferred label/detail.
- A non-identity Helios/Pi-like colour theme and concise status bar while retaining the existing approval overlay and editor.
- Slash commands: `/help`, `/clear`, `/model`, `/resume <session-id>`, and `/tree`.
- Real `/resume` replacement of the active persisted session in the current terminal process.
- `/tree` branch-leaf selection using the Kernel's existing message-tree API.

### Explicitly excluded

- Importing or adapting Pi's agent runtime, extension system, RPC protocol, auth/model session, or tools.
- Token/context footer, a permanent side panel, transcript search, and Pi's complete command catalogue.
- Persisting tree branches across a separate `--resume` process. The current Kernel explicitly reconstructs persisted linear turns and keeps branch topology in memory; this release does not change that Kernel persistence contract.
- Changing provider configuration at runtime. `/model` reports the active configured provider/model and explains that selection happens through the manifest/Kernel configuration.

## Architecture

```text
Helios Kernel Session
  AgentEvent + getDisplayHistory() + message tree API
          |
          v
InteractiveCli
  session subscription, slash-command registry, session replacement boundary
          |
          v
HeliosInteractiveView
  persistent message components, Markdown, thinking, tool cards, overlays
          |
          v
@helios/tui
  Pi-derived terminal primitives only
```

`SessionViewModel` remains the sole raw `AgentEvent` adapter. It owns stable transcript and tool-card state. `HeliosInteractiveView` becomes a renderer of that state, retaining components keyed by `messageId` and `toolUseId` rather than calling `clear()` on every update.

The TUI does not store a duplicate session tree. Its transcript is always a view of the bound `Session`:

- startup and a successful `/resume` hydrate from `session.getDisplayHistory()`;
- `head_changed` causes an atomic rehydrate from that same display history;
- all ordinary agent events update the current model incrementally.

## Event-to-view behaviour

| Kernel event | TUI behaviour |
| --- | --- |
| `message_start` | Create or reuse a persistent user/assistant message shell keyed by `messageId`. |
| `message_update:text-delta` | Append to that message's Markdown content and request a differential repaint. |
| `message_update:thinking-delta` | Append to the message's collapsed/weakly styled thinking component. |
| `message_end` | Mark the component final and ensure final Markdown layout is refreshed. |
| `tool_execution_start` | Create/update the matching compact tool card as running. |
| `tool_execution_end` | Mark its card success/error and show the safe descriptor detail only. |
| `llm_retry`, compaction, `agent_end` | Update status text; `agent_end.error` is displayed as an error status. |
| `head_changed` | Discard only the visual projection, hydrate from `getDisplayHistory()`, then render the newly selected branch. |

The view preserves the existing busy rule: it rejects new user prompts during a running agent. Ctrl+C still delegates to `Session.cancel()`.

## Slash-command contract

Input beginning with `/` is parsed before `Session.sendMessage()`. A command is never passed to the LLM. The registry uses a small host interface so commands can depend on explicit capabilities rather than on TUI internals.

| Command | Behaviour |
| --- | --- |
| `/help` | Opens/prints an overlay listing the supported command syntax and behaviour. |
| `/clear` | Clears only the local transcript/tool projection and leaves Kernel messages, branches, and persisted history untouched. Subsequent agent events build a fresh visible transcript; an explicit branch switch or session resume rehydrates the selected Session history. |
| `/model` | Shows configured provider/model metadata for the active session; it makes no runtime routing/configuration mutation. |
| `/resume <session-id>` | Validates the argument and target session before replacement, cancels/disposes/releases the old runtime, resumes the requested session using its persisted workspace binding, then rebinds the existing TUI to the new `BoundSession`. The view reports the new session ID and restored history. |
| `/tree` | Displays `Session.listBranches()` as a selectable list of branch leaves (short ID, depth, and active marker). Selection calls `Session.switchBranch(leafId)`; the existing `head_changed` event triggers transcript replacement. |

`/resume` is intentionally a host operation rather than a direct TUI call. The CLI main/runtime layer owns workspace leases and `BoundSession` lifecycle, so it exposes an async session-replacement operation to `InteractiveCli`. Preconditions are checked before releasing the active runtime wherever the workspace catalog can establish them. If replacement still fails after release (for example materialization failure), the terminal stays alive, renders the error, and instructs the user to restart with `helios --resume <id>`; it must not silently send messages to the disposed session.

Commands that are malformed, unknown, or disallowed while the agent is busy leave the active session untouched and produce a status/overlay error. `/tree` only offers actual leaves returned by the Kernel, so it never constructs node IDs locally.

## Component boundaries

- `apps/cli/src/tui/sessionViewModel.ts`: add explicit reset/rehydrate and view-friendly command/status state as needed; continue to be the typed `AgentEvent` boundary.
- `apps/cli/src/tui/heliosInteractiveView.ts`: introduce message, thinking, and tool-card presentation components and a Helios theme. Retain editor, terminal lifecycle, keyboard handling, and approval overlays.
- `apps/cli/src/tui/interactiveCli.ts`: define the minimal session-tree and command-host facades, subscribe/unsubscribe safely, route editor text to the command registry or session, and perform rebinding after host session replacement.
- `apps/cli/src/tui/slashCommands.ts` (new): parse commands and contain command-specific validation/dispatch. It knows no terminal implementation details.
- `apps/cli/src/index.ts` and `apps/cli/src/workspaceRuntime.ts`: expose the controlled runtime replacement function needed by `/resume`; preserve existing startup `--resume` behaviour and non-TTY execution.
- `packages/tui`: stays a general Pi-derived rendering library without any Helios Kernel or ports imports.

## Error handling and lifecycle

- Terminal start/stop remains exception-safe and restores terminal state exactly once.
- Rebinding unsubscribes from the old Session before it is disposed and subscribes once to the new Session. Stale events from the old session are ignored.
- `/tree` selection errors retain the old transcript and show an error status.
- `/resume` rejects an empty ID, an unknown/unresumable session, or a busy session before destructive runtime replacement where possible.
- History restoration uses `getDisplayHistory()`, not compressed `getHistory()`, so the user sees physical messages rather than model-only summary substitutions.
- The existing plain renderer remains selected for `--message` and non-TTY IO; slash commands are an interactive TUI feature only.

## Testing and verification

1. Extend `SessionViewModel` tests for incremental message/text/thinking/tool state, error finalization, and reset/rehydration after a simulated `head_changed`.
2. Add view/component tests that prove message and tool components are retained across deltas and Markdown/code content is rendered instead of emitted as raw one-line text.
3. Add command-parser tests: known commands do not call `sendMessage`, malformed/unknown commands report errors, and ordinary text remains unchanged.
4. Add interactive-controller tests using a fake Session/host: `/tree` lists branches, switches the selected leaf, and rehydrates; `/resume` unsubscribes old, binds new, and handles preflight/replacement failure.
5. Keep existing approval, Ctrl+C, non-TTY, and `--message` behaviour under regression tests.
6. Run targeted CLI/TUI tests, full `pnpm test`, `pnpm typecheck`, and a real TTY smoke test against a streaming OpenAI-compatible endpoint. Verify a multi-token answer visibly updates before completion, a code block formats, a tool advances through its states, and `/tree` switches history.

## Acceptance criteria

- Assistant content visually grows during a stream; it is not reconstructed as a full raw-text transcript each event.
- Markdown and code blocks are readable in the interactive terminal, with a coherent Pi-like theme.
- Thinking and tools render as compact structured UI, without exposing tool inputs/outputs by default.
- Existing Helios Kernel events, sessions, ports, and approval flow remain the sole runtime protocol.
- `/help`, `/clear`, `/model`, `/resume <session-id>`, and `/tree` are handled locally, never forwarded to the LLM.
- `/tree` switches an existing in-memory Kernel branch and updates the transcript to that branch.
- `/resume` can genuinely replace the active persisted session in the same terminal process; failure is explicit and terminal cleanup remains correct.
- Non-interactive CLI output preserves its current plain-text semantics.
