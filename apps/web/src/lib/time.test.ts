// @vitest-environment node
import { describe, it, expect } from "vitest";
import { relativeTime, timeGroup } from "./time";

const DAY = 24 * 60 * 60 * 1000;

describe("relativeTime", () => {
  const now = new Date("2026-08-07T12:00:00").getTime();
  it("刚刚 / 分钟 / 小时 / 天", () => {
    expect(relativeTime(now - 10_000, now)).toBe("刚刚");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(relativeTime(now - 3 * 60 * 60_000, now)).toBe("3 小时前");
    expect(relativeTime(now - 2 * DAY, now)).toBe("2 天前");
  });
  it("超过 7 天回落具体日期", () => {
    const out = relativeTime(now - 30 * DAY, now);
    expect(out).toMatch(/月.*日/);
  });
});

describe("timeGroup", () => {
  const now = new Date("2026-08-07T12:00:00").getTime();
  it("今天/昨天/过去7天/更早", () => {
    expect(timeGroup(now - 60_000, now)).toBe("今天");
    expect(timeGroup(now - DAY, now)).toBe("昨天");
    expect(timeGroup(now - 4 * DAY, now)).toBe("过去 7 天");
    expect(timeGroup(now - 30 * DAY, now)).toBe("更早");
  });
});
