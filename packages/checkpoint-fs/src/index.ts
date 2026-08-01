import { cp, mkdir, rm, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import type { CheckpointPort, Ref, KernelContext } from "@helios/ports";
import { CHECKPOINT_PORT_API_VERSION } from "@helios/ports";

// @helios/checkpoint-fs —— CheckpointPort 官方朴素实现：全目录复制快照。
// P1 用它验证接口通不通；P2 由 checkpoint-git 影子快照替换，调用方零改动。

const EXCLUDE = new Set(["node_modules", ".git", ".helios"]);

function makeFilter(root: string): (src: string) => boolean {
  return (src: string): boolean => {
    const rel = src.slice(root.length).split(sep).filter(Boolean);
    return !rel.some((seg) => EXCLUDE.has(seg));
  };
}

class FsCheckpoint implements CheckpointPort {
  private readonly baseDir: string;
  constructor(private readonly workDir: string) {
    // 快照存放于 workDir 之外：node fs.cp 禁止把目录拷进自身子目录（早于 filter 判断）。
    this.baseDir = join(tmpdir(), "helios-checkpoints", workDir.replace(/[^\w.-]/g, "_"));
  }

  private dirFor(turnId: string): string {
    return join(this.baseDir, turnId.replace(/[^\w.-]/g, "_"));
  }

  async snapshot(turnId: string): Promise<Ref> {
    const dest = this.dirFor(turnId);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await cp(this.workDir, dest, {
      recursive: true,
      filter: makeFilter(this.workDir),
    });
    return { kind: "fs", value: turnId.replace(/[^\w.-]/g, "_") };
  }

  async restore(ref: Ref): Promise<void> {
    const src = join(this.baseDir, ref.value);
    // 先清空 workDir 中的非排除项，使 work-tree 精确回到快照状态（含删除快照后新增的文件），
    // 再把快照覆盖回来。node_modules/.git/.helios 不动。
    for (const entry of await readdir(this.workDir)) {
      if (EXCLUDE.has(entry)) continue;
      await rm(join(this.workDir, entry), { recursive: true, force: true });
    }
    await cp(src, this.workDir, {
      recursive: true,
      force: true,
      filter: makeFilter(src),
    });
  }
}

export const apiVersion = CHECKPOINT_PORT_API_VERSION;

export function create(ctx: KernelContext): CheckpointPort {
  return new FsCheckpoint(ctx.workDir);
}

export default { apiVersion, create };
