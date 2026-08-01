import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import fg from "fast-glob";
import type { FileSystemPort, KernelContext } from "@helios/ports";
import { FILESYSTEM_PORT_API_VERSION } from "@helios/ports";

// @helios/fs-node —— FileSystemPort 官方默认实现（Node fs/promises + fast-glob）。
// 所有相对路径以 ctx.workDir 为基准解析。

class NodeFileSystem implements FileSystemPort {
  constructor(private readonly workDir: string) {}

  private abs(path: string): string {
    return isAbsolute(path) ? path : resolve(this.workDir, path);
  }

  async readFile(path: string): Promise<string> {
    return readFile(this.abs(path), "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = this.abs(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async glob(pattern: string): Promise<string[]> {
    return fg(pattern, {
      cwd: this.workDir,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }
}

export const apiVersion = FILESYSTEM_PORT_API_VERSION;

export function create(ctx: KernelContext): FileSystemPort {
  return new NodeFileSystem(ctx.workDir);
}

export default { apiVersion, create };
