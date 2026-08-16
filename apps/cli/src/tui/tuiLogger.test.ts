import { describe, expect, it } from "vitest";
import { createTuiLogger } from "./tuiLogger";

describe("createTuiLogger", () => {
  it("buffers warnings until a sink exists and then forwards them", () => {
    const logger = createTuiLogger();
    logger.warn("compaction 记录持久化失败");
    logger.error(new Error("provider unavailable"));

    const lines: string[] = [];
    logger.attach((line) => lines.push(line));
    expect(lines).toEqual(["[warn] compaction 记录持久化失败", "[error] provider unavailable"]);

    logger.warn("later");
    expect(lines.at(-1)).toBe("[warn] later");
  });

  it("drops debug/info so nothing writes to stdout behind the rendered frame", () => {
    const logger = createTuiLogger();
    logger.debug("noisy");
    logger.info("已加载插件");

    const lines: string[] = [];
    logger.attach((line) => lines.push(line));
    expect(lines).toEqual([]);
  });
});
