import { describe, it, expect } from "vitest";
import type { KernelContext, Logger, Tool } from "@helios/ports";
import { create } from "./index";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const ctx = { workDir: "/tmp", logger: silent } as unknown as KernelContext;

function toolMap(tools: Tool[]): Record<string, Tool> {
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

const noCtx = {} as unknown as Parameters<Tool["execute"]>[1];

describe("cap-cron CapabilityProvider", () => {
  it("schedule → list → cancel 生命周期", async () => {
    const provider = create(ctx);
    provider.activate(ctx);
    const t = toolMap(provider.getTools!());

    const scheduled = await t.schedule.execute({ cron: "*/5 * * * *", note: "报表" }, noCtx);
    expect(scheduled.isError).toBeFalsy();
    expect(String(scheduled.output)).toContain("job_1");

    const listed = JSON.parse(String((await t.list.execute({}, noCtx)).output));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "job_1", cron: "*/5 * * * *", note: "报表" });

    const cancelled = await t.cancel.execute({ id: "job_1" }, noCtx);
    expect(cancelled.isError).toBeFalsy();
    expect(JSON.parse(String((await t.list.execute({}, noCtx)).output))).toHaveLength(0);

    await provider.dispose!();
  });

  it("拒绝非法 cron 表达式", async () => {
    const provider = create(ctx);
    provider.activate(ctx);
    const t = toolMap(provider.getTools!());
    const res = await t.schedule.execute({ cron: "not a cron" }, noCtx);
    expect(res.isError).toBe(true);
    expect(String(res.output)).toContain("非法");
    await provider.dispose!();
  });

  it("取消不存在的任务返回错误", async () => {
    const provider = create(ctx);
    provider.activate(ctx);
    const t = toolMap(provider.getTools!());
    const res = await t.cancel.execute({ id: "job_404" }, noCtx);
    expect(res.isError).toBe(true);
  });

  it("秒级任务会真实触发并累加 fireCount", async () => {
    const provider = create(ctx);
    provider.activate(ctx);
    const t = toolMap(provider.getTools!());
    await t.schedule.execute({ cron: "* * * * * *", note: "tick" }, noCtx);
    await new Promise((r) => setTimeout(r, 1300));
    const listed = JSON.parse(String((await t.list.execute({}, noCtx)).output));
    expect(listed[0].fireCount).toBeGreaterThanOrEqual(1);
    await provider.dispose!();
  });
});
