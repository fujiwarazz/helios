import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile as fsWrite, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelContext } from "@helios/ports";
import { create, WorkDirGuard, NoopGuard } from "./index";

let workDir: string;
let outsideDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-fsguard-"));
  outsideDir = await mkdtemp(join(tmpdir(), "helios-outside-"));
  return async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  };
});

function fs() {
  return create({ workDir } as unknown as KernelContext);
}

describe("PathGuard 类（可插拔隔离策略）", () => {
  it("WorkDirGuard 放行 workDir 内、拒绝 workDir 外", () => {
    const g = new WorkDirGuard("/home/u/work");
    expect(() => g.assertAllowed("/home/u/work/a/b.txt", "read")).not.toThrow();
    expect(() => g.assertAllowed("/home/u/work", "read")).not.toThrow();
    expect(() => g.assertAllowed("/etc/passwd", "read")).toThrow(/越界/);
    // 前缀欺骗：/home/u/work-evil 不属于 /home/u/work
    expect(() => g.assertAllowed("/home/u/work-evil/x", "write")).toThrow(/越界/);
  });

  it("NoopGuard 放行一切", () => {
    const g = new NoopGuard();
    expect(() => g.assertAllowed("/etc/passwd", "read")).not.toThrow();
  });
});

describe("fs-node 默认 WorkDirGuard 越界隔离", () => {
  it("workDir 内读写正常", async () => {
    const f = fs();
    await f.writeFile("sub/a.txt", "hello");
    expect(await f.readFile("sub/a.txt")).toBe("hello");
    expect(await f.exists("sub/a.txt")).toBe(true);
  });

  it("绝对路径越界读被拒", async () => {
    await expect(fs().readFile("/etc/hosts")).rejects.toThrow(/越界/);
  });

  it("相对 .. 越界读被拒", async () => {
    await expect(fs().readFile("../../../../etc/hosts")).rejects.toThrow(/越界/);
  });

  it("越界写被拒", async () => {
    await expect(fs().writeFile(join(outsideDir, "evil.txt"), "x")).rejects.toThrow(/越界/);
  });

  it("glob 含 .. 被拒", async () => {
    await expect(fs().glob("../**")).rejects.toThrow(/\.\./);
  });

  it("workDir 内软链指向外部 → 经 realpath 校验被拒", async () => {
    await fsWrite(join(outsideDir, "secret.txt"), "TOP_SECRET");
    await mkdir(join(workDir, "d"), { recursive: true });
    await symlink(outsideDir, join(workDir, "d", "link"), "dir");
    // 路径字面在 workDir 内，但 realpath 解析后落在 outsideDir → 拒绝
    await expect(fs().readFile("d/link/secret.txt")).rejects.toThrow(/越界/);
  });

  it("写入指向外部的既有叶子软链 → 折叠后落点越界被拒", async () => {
    // 叶子本身是软链，父目录在 workDir 内：旧实现只 realpath 父目录会漏判。
    await fsWrite(join(outsideDir, "target.txt"), "orig");
    await symlink(join(outsideDir, "target.txt"), join(workDir, "leaklink"), "file");
    await expect(fs().writeFile("leaklink", "HACKED")).rejects.toThrow(/越界/);
  });

  it("ENOENT 祖先中含指向外部的软链 → 折叠后越界被拒", async () => {
    // workDir/esc -> outsideDir（目录软链），写 esc/new/x.txt 时 new/ 尚不存在。
    await symlink(outsideDir, join(workDir, "esc"), "dir");
    await expect(fs().writeFile("esc/new/x.txt", "y")).rejects.toThrow(/越界/);
  });
});
