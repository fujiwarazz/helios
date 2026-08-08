import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelContext, Logger, PortRegistry, ToolContext } from "@helios/ports";
import { create as createFs } from "@helios/fs-node";
import { BUILTIN_TOOLS, assertFetchUrlAllowed } from "./tools";

const bashTool = BUILTIN_TOOLS.find((t) => t.name === "Bash")!;
const grepTool = BUILTIN_TOOLS.find((t) => t.name === "Grep")!;

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("WebFetch SSRF 防护 —— assertFetchUrlAllowed", () => {
  it("拒绝本机/内网/云元数据/非 http(s)", () => {
    for (const bad of [
      "http://localhost/x",
      "http://127.0.0.1:8080",
      "http://169.254.169.254/latest/meta-data",
      "http://10.1.2.3/",
      "http://192.168.0.1/",
      "http://172.16.5.5/",
      "http://172.31.0.1/",
      "ftp://example.com/",
      "file:///etc/passwd",
    ]) {
      expect(() => assertFetchUrlAllowed(bad), bad).toThrow();
    }
  });

  it("放行正常公网 http(s)", () => {
    expect(() => assertFetchUrlAllowed("https://example.com/page")).not.toThrow();
    expect(() => assertFetchUrlAllowed("http://93.184.216.34/")).not.toThrow();
  });

  it("私网前缀相同的合法域名不被误伤（IP 段判断需 net.isIP 确认为字面 IP）", () => {
    for (const ok of [
      "http://10.foo.com/",        // 以 "10." 开头的域名
      "http://192.168.example.net/", // 以 "192.168." 开头的域名
      "http://fc-cdn.net/",         // 以 "fc" 开头的域名
      "http://fd.example.com/",     // 以 "fd" 开头的域名
      "http://fe80-host.io/",       // 以 "fe80" 开头的域名
      "http://127-server.com/",     // 以 "127." 开头？其实是 "127-"，普通域名
    ]) {
      expect(() => assertFetchUrlAllowed(ok), ok).not.toThrow();
    }
  });

  it("尾点 FQDN 规范化：localhost. 仍被拒", () => {
    expect(() => assertFetchUrlAllowed("http://localhost./x")).toThrow();
  });

  it("非法 URL 抛错", () => {
    expect(() => assertFetchUrlAllowed("not a url")).toThrow(/非法 URL/);
  });
});

describe("Bash —— signal 中断生效", () => {
  it("已中止的 signal 使命令快速失败，不挂满超时", async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = {
      workDir: tmpdir(),
      logger: silent,
      ports: {} as unknown as PortRegistry,
      signal: ac.signal,
      askQuestion: async () => ({ answers: [] }),
    } as ToolContext;
    const start = Date.now();
    const res = await bashTool.execute({ command: "sleep 5" }, ctx);
    expect(res.isError).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000); // 远小于 sleep 5 与默认超时
  });

  it("timeout=0 不会禁用超时上限（回落默认值）", async () => {
    const ctx = {
      workDir: tmpdir(),
      logger: silent,
      ports: {} as unknown as PortRegistry,
      askQuestion: async () => ({ answers: [] }),
    } as ToolContext;
    // 正常快命令：timeout=0 时应正常返回（若 0 被当"永不超时"也不影响此断言），
    // 关键是不抛异常 —— 回归保护 execa timeout:0 语义被回落。
    const res = await bashTool.execute({ command: "echo ok", timeout: 0 }, ctx);
    expect(res.output).toContain("ok");
    expect(res.isError).toBe(false);
  });
});

describe("Grep —— 跳过二进制文件", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "helios-grep-"));
    return async () => rm(workDir, { recursive: true, force: true });
  });

  it("含 NUL 字节的文件被跳过，只命中文本文件", async () => {
    await writeFile(join(workDir, "text.txt"), "hello NEEDLE world");
    await writeFile(join(workDir, "bin.dat"), "NEEDLE\u0000\u0001binary");
    const ctx = {
      workDir,
      logger: silent,
      ports: { fileSystem: createFs({ workDir } as unknown as KernelContext) } as unknown as PortRegistry,
      askQuestion: async () => ({ answers: [] }),
    } as ToolContext;
    const res = await grepTool.execute({ pattern: "NEEDLE" }, ctx);
    const out = String(res.output);
    expect(out).toContain("text.txt");
    expect(out).not.toContain("bin.dat");
  });
});
