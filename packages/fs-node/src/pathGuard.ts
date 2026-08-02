import { relative, isAbsolute } from "node:path";

/**
 * 路径守卫（可插拔）：隔离落在 FileSystemPort 底层实现里，而非散在各工具层。
 * 「隔离多严」是实现选择，不动 kernel。越界即 throw。
 */
export interface PathGuard {
  assertAllowed(absPath: string, op: "read" | "write"): void;
}

/** 默认守卫：把读写限制在 workDir 内。先 resolve 折叠 `..` 再比较，杜绝前缀欺骗。 */
export class WorkDirGuard implements PathGuard {
  constructor(private readonly workDir: string) {}

  assertAllowed(absPath: string, _op: "read" | "write"): void {
    const rel = relative(this.workDir, absPath);
    // rel === "" 表示就是 workDir 本身；以 ".." 开头或仍是绝对路径 = 越界。
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new Error(`路径越界，拒绝访问 workDir 之外：${absPath}`);
    }
  }
}

/** 放行一切（用户显式要求全盘访问时使用）。 */
export class NoopGuard implements PathGuard {
  assertAllowed(_absPath: string, _op: "read" | "write"): void {}
}
