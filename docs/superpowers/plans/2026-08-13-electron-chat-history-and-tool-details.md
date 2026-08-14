# Electron Chat History and Tool Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Electron chat connection status accurate, preserve full visible history after LLM compaction, and expose each tool call's input and output.

**Architecture:** Keep `Session.getHistory()` as the compacted LLM context and add a separate display-history path over the same physical message branch. The UI uses the display path, while tool cards retain event input/output and render a generic collapsed detail when a specialized renderer does not provide one. `RpcClient` replays its current state to late subscribers so replacement chat clients cannot inherit a stale closed state.

**Tech Stack:** TypeScript, React 18, Vitest, Electron IPC, Helios RPC.

---

### Task 1: Replay the current RPC connection state

**Files:**
- Modify: `packages/protocol/src/client.ts`
- Test: `packages/protocol/src/rpc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("onState immediately reports the current open state to late subscribers", async () => {
  const { client } = makeLoopbackPair();
  const rpc = new RpcClient(() => client);
  await Promise.resolve();
  const states: ConnectionState[] = [];
  rpc.onState((state) => states.push(state));
  expect(states).toEqual(["open"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/protocol/src/rpc.test.ts`

Expected: the new assertion fails because `onState` only records a callback.

- [ ] **Step 3: Implement the minimal subscription replay**

```ts
onState(cb: (s: ConnectionState) => void): Disposable {
  this.stateSubs.add(cb);
  cb(this.state);
  return { dispose: () => this.stateSubs.delete(cb) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/protocol/src/rpc.test.ts`

Expected: all protocol RPC tests pass.

### Task 2: Separate display history from compacted LLM history

**Files:**
- Modify: `packages/kernel/src/session.ts`
- Modify: `packages/host/src/index.ts`
- Modify: `packages/ui-chat/src/RpcChatClient.ts`
- Test: `packages/kernel/test/branch-tree.test.ts`
- Test: `packages/host/src/electronIpc.test.ts`

- [ ] **Step 1: Write failing kernel and host tests**

```ts
expect(session.getHistory().some((m) => textOf(m).includes("ALPHA_FIRST_USER"))).toBe(false);
expect(session.getDisplayHistory().some((m) => textOf(m).includes("ALPHA_FIRST_USER"))).toBe(true);
```

```ts
const history = (await rpc.call("displayHistory")) as Message[];
expect(history.some((m) => m.role === "assistant")).toBe(true);
```

- [ ] **Step 2: Run the focused tests to verify the new API is absent**

Run: `pnpm vitest run packages/kernel/test/branch-tree.test.ts packages/host/src/electronIpc.test.ts`

Expected: TypeScript/test failures because `getDisplayHistory` and `displayHistory` do not exist.

- [ ] **Step 3: Implement an uncompressed branch traversal and RPC**

```ts
getDisplayHistory(): Message[] {
  return [...this.ancestorChain(this.headId)].reverse();
}
```

```ts
displayHistory: () => session.getDisplayHistory(),
```

```ts
return (await this.rpc.call("displayHistory")) as Message[];
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm vitest run packages/kernel/test/branch-tree.test.ts packages/host/src/electronIpc.test.ts`

Expected: compaction still affects `getHistory`, while display history preserves original messages.

### Task 3: Render generic input/output details for every tool call

**Files:**
- Modify: `packages/ui-chat/src/types.ts`
- Modify: `packages/ui-chat/src/useChat.ts`
- Modify: `packages/ui-chat/src/ChatView.tsx`
- Test: `packages/ui-chat/src/useChat.test.tsx`
- Test: `packages/ui-chat/src/ChatView.test.tsx`

- [ ] **Step 1: Write failing reducer and component tests**

```ts
expect(result.current.messages[0].tools[0]).toMatchObject({
  input: { path: "a" },
  output: "ok",
});
```

```ts
fireEvent.click(screen.getByTestId("tool-card").querySelector("button")!);
expect(screen.getByTestId("tool-card").textContent).toContain('"path": "a"');
expect(screen.getByTestId("tool-card").textContent).toContain("ok");
```

- [ ] **Step 2: Run the UI tests to verify they fail**

Run: `pnpm vitest run packages/ui-chat/src/useChat.test.tsx packages/ui-chat/src/ChatView.test.tsx`

Expected: tool view does not retain input/output and the generic card is not expandable.

- [ ] **Step 3: Implement retained event data and a safe generic detail formatter**

```ts
interface ToolCallView {
  input?: unknown;
  output?: unknown;
}
```

```ts
const genericDetail = formatToolDetail(tool.input, tool.output);
const detail = tool.descriptor?.detail ?? genericDetail;
```

The formatter serializes JSON when possible, falls back to `String`, and labels input/output separately.

- [ ] **Step 4: Run the UI tests to verify they pass**

Run: `pnpm vitest run packages/ui-chat/src/useChat.test.tsx packages/ui-chat/src/ChatView.test.tsx`

Expected: cards remain collapsed initially and show input/output when expanded.

### Task 4: Lock the long-running send contract and run final verification

**Files:**
- Modify: `packages/ui-chat/src/RpcChatClient.test.ts`
- Test: `packages/ui-chat/src/RpcChatClient.test.ts`
- Test: `packages/protocol/src/rpc.test.ts`
- Test: `packages/kernel/test/branch-tree.test.ts`
- Test: `packages/host/src/electronIpc.test.ts`
- Test: `packages/ui-chat/src/useChat.test.tsx`
- Test: `packages/ui-chat/src/ChatView.test.tsx`

- [ ] **Step 1: Write a failing client contract test**

```ts
await client.sendMessage("long task");
expect(call).toHaveBeenCalledWith("sendMessage", { text: "long task" }, { timeoutMs: 0 });
```

- [ ] **Step 2: Run the test to verify it fails if the contract is removed**

Run: `pnpm vitest run packages/ui-chat/src/RpcChatClient.test.ts`

Expected: the test proves the exact no-timeout option passed to the RPC layer.

- [ ] **Step 3: Keep the existing explicit no-timeout call and add the test file**

```ts
await this.rpc.call("sendMessage", { text }, { timeoutMs: 0 });
```

- [ ] **Step 4: Run focused tests, type checks, and the Electron production build**

Run: `pnpm vitest run packages/protocol/src/rpc.test.ts packages/kernel/test/branch-tree.test.ts packages/host/src/electronIpc.test.ts packages/ui-chat/src/useChat.test.tsx packages/ui-chat/src/ChatView.test.tsx packages/ui-chat/src/RpcChatClient.test.ts && pnpm --filter @helios/ui-chat typecheck && pnpm --filter @helios/host typecheck && pnpm --filter @helios/electron typecheck && pnpm --filter @helios/electron build`

Expected: all tests, type checks, and the Electron build exit with status 0.
