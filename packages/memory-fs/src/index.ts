import type {
  MemoryPort,
  MemoryEntry,
  KernelContext,
  FileSystemPort,
} from "@helios/ports";
import { MEMORY_PORT_API_VERSION } from "@helios/ports";
import { createGuardedFileSystem } from "@helios/fs-node";

// @helios/memory-fs —— MemoryPort 官方文件实现。
// 经 ctx.ports.fileSystem 读写（验证跨 Port 加载顺序：fs 必须在 memory 之前加载）。
// 结构：.helios/memory/MEMORY.md（索引） + .helios/memory/<key>.md（主题文件）。

const DIR = ".helios/memory";

class FsMemory implements MemoryPort {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly directory = DIR,
  ) {}

  private get index(): string {
    return `${this.directory}/MEMORY.md`;
  }

  async recall(_query: string): Promise<string> {
    // 朴素实现：返回索引全文，交由 LLM 自行取用。用户可换成向量库 top-k。
    if (await this.fs.exists(this.index)) {
      return this.fs.readFile(this.index);
    }
    return "";
  }

  async remember(entry: MemoryEntry): Promise<void> {
    const key = entry.key ?? `note-${entry.ts}`;
    const safeKey = key.replace(/[^\w.-]/g, "_");
    const topicPath = `${this.directory}/${safeKey}.md`;
    await this.fs.writeFile(topicPath, entry.text);

    const line = `- [${key}](./${safeKey}.md)${entry.tags?.length ? ` — ${entry.tags.join(", ")}` : ""}\n`;
    const prev = (await this.fs.exists(this.index))
      ? await this.fs.readFile(this.index)
      : "# Memory Index\n\n";
    if (!prev.includes(`(./${safeKey}.md)`)) {
      await this.fs.writeFile(this.index, prev + line);
    }
  }
}

export const apiVersion = MEMORY_PORT_API_VERSION;

export function create(ctx: KernelContext): MemoryPort {
  const storageDir = ctx.options?.storageDir;
  if (typeof storageDir === "string") {
    return new FsMemory(createGuardedFileSystem(storageDir), ".");
  }
  return new FsMemory(ctx.ports.fileSystem);
}

export default { apiVersion, create };
