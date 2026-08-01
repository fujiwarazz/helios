import type {
  CapabilityProvider,
  Tool,
  KernelContext,
  FileSystemPort,
} from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

// @helios/capability-fs —— CapabilityProvider 官方文件扫描实现（替代原 Skill+Extension）。
// 扫描 .helios/capabilities/<name>/SKILL.md，每个目录产出一个工具：调用即返回该 skill 全文，
// 供 Agent 按需加载领域指引。是否做"分层解锁"由本实现自行决定，不属接口契约。

const GLOB = ".helios/capabilities/*/SKILL.md";

interface ScannedSkill {
  name: string;
  path: string;
}

class FsCapability implements CapabilityProvider {
  readonly name = "caps";
  private skills: ScannedSkill[] = [];
  constructor(private readonly fs: FileSystemPort) {}

  async activate(): Promise<void> {
    const files = await this.fs.glob(GLOB);
    this.skills = files.map((path) => {
      const parts = path.split("/");
      const dirName = parts[parts.length - 2] ?? "skill";
      return { name: dirName.replace(/[^\w.-]/g, "_"), path };
    });
  }

  getTools(): Tool[] {
    return this.skills.map((skill) => this.toTool(skill));
  }

  private toTool(skill: ScannedSkill): Tool {
    const fs = this.fs;
    return {
      name: skill.name,
      description: `加载 skill「${skill.name}」的完整指引内容`,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        try {
          const content = await fs.readFile(skill.path);
          return { output: content };
        } catch (err) {
          return {
            output: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    };
  }
}

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;

export function create(ctx: KernelContext): CapabilityProvider {
  return new FsCapability(ctx.ports.fileSystem);
}

export default { apiVersion, create };
