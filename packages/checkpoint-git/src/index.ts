import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import type { CheckpointPort, Ref, KernelContext } from "@helios/ports";
import { CHECKPOINT_PORT_API_VERSION } from "@helios/ports";

/**
 * @helios/checkpoint-git —— CheckpointPort 的影子 git 实现（P2）。
 *
 * 与 checkpoint-fs 行为等价、可零改动互换：
 * - snapshot：把 workDir 当作 work-tree，用一个独立于用户 .git 的“影子” git-dir
 *   做 `add -A → write-tree → commit-tree`，返回 commit hash 作为 Ref。
 * - restore：`read-tree <commit> → checkout-index -f -a`，把 tree 覆盖回 work-tree。
 *
 * 关键：git-dir 放在 workDir 之外的 tmpdir，绝不碰用户真实仓库；
 * info/exclude 排除 node_modules/.git/.helios，避免快照污染。
 */
const EXCLUDE = ["node_modules/", ".git/", ".helios/"];

class GitCheckpoint implements CheckpointPort {
  private readonly gitDir: string;
  private initialized = false;

  constructor(private readonly workDir: string) {
    this.gitDir = join(
      tmpdir(),
      "helios-checkpoints-git",
      workDir.replace(/[^\w.-]/g, "_"),
    );
  }

  /** 影子 git 的通用参数：指定 git-dir 与 work-tree，并压制身份/GPG 依赖。 */
  private args(rest: string[]): string[] {
    return [
      `--git-dir=${this.gitDir}`,
      `--work-tree=${this.workDir}`,
      "-c",
      "core.autocrlf=false",
      ...rest,
    ];
  }

  private async git(rest: string[]): Promise<string> {
    const { stdout } = await execa("git", this.args(rest), {
      cwd: this.workDir,
      env: {
        GIT_AUTHOR_NAME: "helios",
        GIT_AUTHOR_EMAIL: "helios@local",
        GIT_COMMITTER_NAME: "helios",
        GIT_COMMITTER_EMAIL: "helios@local",
      },
    });
    return stdout.trim();
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await rm(this.gitDir, { recursive: true, force: true });
    await mkdir(this.gitDir, { recursive: true });
    await this.git(["init", "-q"]);
    await writeFile(join(this.gitDir, "info", "exclude"), EXCLUDE.join("\n") + "\n", "utf8");
    this.initialized = true;
  }

  async snapshot(turnId: string): Promise<Ref> {
    await this.ensureInit();
    await this.git(["add", "-A"]);
    const tree = await this.git(["write-tree"]);
    const commit = await this.git(["commit-tree", tree, "-m", turnId]);
    return { kind: "git", value: commit };
  }

  async restore(ref: Ref): Promise<void> {
    await this.ensureInit();
    // read-tree 把 commit 的 tree 载入 index；checkout-index 强制写回已跟踪文件；
    // clean -fd 删除快照后新增的未跟踪文件（受 info/exclude 保护，node_modules 等不动），
    // 三步组合使 work-tree 精确回到快照状态（含删除）。
    await this.git(["read-tree", ref.value]);
    await this.git(["checkout-index", "-f", "-a"]);
    await this.git(["clean", "-fd"]);
  }
}

export const apiVersion = CHECKPOINT_PORT_API_VERSION;

export function create(ctx: KernelContext): CheckpointPort {
  return new GitCheckpoint(ctx.workDir);
}

export default { apiVersion, create };
