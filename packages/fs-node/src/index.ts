import { readFile, writeFile, mkdir, access, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, basename, join, resolve, isAbsolute } from "node:path";
import fg from "fast-glob";
import type { FileSystemPort, KernelContext } from "@helios/ports";
import { FILESYSTEM_PORT_API_VERSION } from "@helios/ports";
import { type PathGuard, WorkDirGuard } from "./pathGuard";

export { type PathGuard, WorkDirGuard, NoopGuard } from "./pathGuard";

// @helios/fs-node —— FileSystemPort 官方默认实现（Node fs/promises + fast-glob）。
// 所有相对路径以 ctx.workDir 为基准解析，并经可插拔 PathGuard 做越界隔离。

class NodeFileSystem implements FileSystemPort {
  constructor(
    private readonly workDir: string,
    private readonly guard: PathGuard = new WorkDirGuard(workDir),
  ) {}

  /**
   * 归一化路径并做越界隔离：
   * ① isAbsolute?resolve → 折叠 `..`；② 纯路径 guard 校验；
   * ③ 解析「最深已存在祖先」的 realpath 后再校验，把尚不存在的层级原样拼回。
   * 这样无论叶子本身是软链（写入已存在的软链文件）、还是中间祖先是软链，
   * 都会被折叠成真实路径后校验，杜绝 workDir 内软链指向外部的绕过。
   */
  private async resolveWithin(path: string, op: "read" | "write"): Promise<string> {
    const full = isAbsolute(path) ? path : resolve(this.workDir, path);
    this.guard.assertAllowed(full, op); // 纯路径校验（先于符号链接解析）
    const real = await this.realpathExistingPrefix(full);
    this.guard.assertAllowed(real, op); // 折叠软链后再校验真实落点
    return real;
  }

  /**
   * 从 full 向上寻找最深的已存在祖先并 realpath（折叠所有软链），
   * 再把剩余尚不存在的层级原样拼回。既解析叶子软链，也解析中间祖先软链。
   */
  private async realpathExistingPrefix(full: string): Promise<string> {
    const missing: string[] = [];
    let cur = full;
    for (;;) {
      try {
        const real = await realpath(cur);
        return missing.length ? join(real, ...missing.reverse()) : real;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
        const parent = dirname(cur);
        if (parent === cur) return full; // 抵达根仍不存在：极端情况，返回原值
        missing.push(basename(cur));
        cur = parent;
      }
    }
  }

  async readFile(path: string): Promise<string> {
    return readFile(await this.resolveWithin(path, "read"), "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = await this.resolveWithin(path, "write");
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async glob(pattern: string): Promise<string[]> {
    // pattern 含 `..` 可越出 cwd，cwd:workDir 挡不住 —— 直接拒绝。
    if (pattern.includes("..")) {
      throw new Error(`glob 模式不得包含 ..（越界）：${pattern}`);
    }
    return fg(pattern, {
      cwd: this.workDir,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(await this.resolveWithin(path, "read"));
      return true;
    } catch {
      return false;
    }
  }
}

export const apiVersion = FILESYSTEM_PORT_API_VERSION;

export function create(ctx: KernelContext): FileSystemPort {
  // 归一化 workDir 到真实路径（如 macOS /var → /private/var），
  // 使其与 readFile/realpath 解析出的目标路径同源，避免同一目录被误判越界。
  let realWorkDir = ctx.workDir;
  try {
    realWorkDir = realpathSync(ctx.workDir);
  } catch {
    // workDir 尚不存在等：退回原值。
  }
  return new NodeFileSystem(realWorkDir);
}

export default { apiVersion, create };
