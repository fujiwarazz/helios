import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspacePaths } from "./paths";

const SAFE_TOPIC = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class WorkspaceMemoryStore {
  constructor(private readonly paths: WorkspacePaths) {}

  async readIndex(workspaceId: string): Promise<string> {
    return readOptional(join(this.paths.memoryDir(workspaceId), "MEMORY.md"));
  }

  async writeIndex(workspaceId: string, content: string): Promise<void> {
    const directory = this.paths.memoryDir(workspaceId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "MEMORY.md"), content, "utf8");
  }

  async readTopic(workspaceId: string, topic: string): Promise<string> {
    return readOptional(this.topicPath(workspaceId, topic));
  }

  async writeTopic(workspaceId: string, topic: string, content: string): Promise<void> {
    const directory = this.paths.memoryDir(workspaceId);
    const file = this.topicPath(workspaceId, topic);
    await mkdir(directory, { recursive: true });
    await writeFile(file, content, "utf8");
  }

  private topicPath(workspaceId: string, topic: string): string {
    if (!SAFE_TOPIC.test(topic)) throw new Error(`invalid topic: ${JSON.stringify(topic)}`);
    return join(this.paths.memoryDir(workspaceId), `${topic}.md`);
  }
}

async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
