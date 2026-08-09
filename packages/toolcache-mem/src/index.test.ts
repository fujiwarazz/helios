import { describe, it, expect, vi, afterEach } from "vitest";
import type { ToolCacheKey } from "@helios/ports";
import { create } from "./index";

function cache() {
  return create({ options: {} } as never);
}
const key = (over: Partial<ToolCacheKey> = {}): ToolCacheKey => ({
  toolName: "Read",
  argsCanonical: JSON.stringify({ path: "foo.ts" }),
  scope: "session",
  scopeId: "s1",
  ...over,
});

afterEach(() => vi.useRealTimers());

describe("toolcache-mem", () => {
  it("set 后 get 命中", async () => {
    const c = cache();
    await c.set(key(), { output: "content-A" });
    expect(await c.get(key())).toEqual({ output: "content-A" });
  });

  it("version 变化即 miss（workspace 被 Edit 后 snapshot 变 → 不返回陈旧内容）", async () => {
    const c = cache();
    await c.set(key({ version: "snapA" }), { output: "old" });
    expect(await c.get(key({ version: "snapA" }))).toEqual({ output: "old" });
    expect(await c.get(key({ version: "snapB" }))).toBeUndefined(); // Edit 后新版本 → miss
  });

  it("scope/scopeId 不同即不同条目", async () => {
    const c = cache();
    await c.set(key({ scope: "run", scopeId: "run-1" }), { output: "r1" });
    expect(await c.get(key({ scope: "run", scopeId: "run-2" }))).toBeUndefined();
    expect(await c.get(key({ scope: "session", scopeId: "s1" }))).toBeUndefined();
  });

  it("TTL 过期后 miss", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const c = cache();
    await c.set(key({ scope: "global", scopeId: "g" }), { output: "web" }, 1000);
    vi.setSystemTime(500);
    expect(await c.get(key({ scope: "global", scopeId: "g" }))).toEqual({ output: "web" });
    vi.setSystemTime(1001);
    expect(await c.get(key({ scope: "global", scopeId: "g" }))).toBeUndefined();
  });

  it("无 TTL 不过期", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const c = cache();
    await c.set(key(), { output: "persist" });
    vi.setSystemTime(10_000_000);
    expect(await c.get(key())).toEqual({ output: "persist" });
  });
});
