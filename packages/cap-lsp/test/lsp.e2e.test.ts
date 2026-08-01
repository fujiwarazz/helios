import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import type { KernelContext, Logger, Tool } from "@helios/ports";
import { create } from "../src/index";

// 外部进程集成测试：默认跳过，HELIOS_LSP_E2E=1 时启用
// （spawn typescript-language-server，需 devDep 已安装）。
const ENABLED = process.env.HELIOS_LSP_E2E === "1";
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const workDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const bin = fileURLToPath(new URL("../node_modules/.bin/typescript-language-server", import.meta.url));
const noCtx = {} as unknown as Parameters<Tool["execute"]>[1];

describe.skipIf(!ENABLED)("cap-lsp typescript-language-server 集成", () => {
  it("hover / definition 返回结果", async () => {
    const ctx = {
      workDir,
      logger: silent,
      options: { command: bin, args: ["--stdio"] },
    } as unknown as KernelContext;

    const provider = create(ctx);
    await provider.activate(ctx);
    const tools = Object.fromEntries(provider.getTools!().map((t) => [t.name, t]));

    // 第 4 行 `const message = greet("world");` 里 greet 调用（0 基），character 指向 greet
    const hover = await tools.hover.execute({ file_path: "sample.ts", line: 4, character: 17 }, noCtx);
    expect(hover.isError).toBeFalsy();
    expect(String(hover.output)).toContain("greet");

    const def = await tools.definition.execute({ file_path: "sample.ts", line: 4, character: 17 }, noCtx);
    expect(def.isError).toBeFalsy();
    expect(String(def.output)).toContain("sample.ts");

    await provider.dispose!();
  }, 20000);
});
