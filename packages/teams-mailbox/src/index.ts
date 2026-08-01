import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  MultiAgentPort,
  AgentSpec,
  AgentHandle,
  AgentMessage,
  Disposable,
  KernelContext,
} from "@helios/ports";
import { MULTI_AGENT_PORT_API_VERSION } from "@helios/ports";

// @helios/teams-mailbox —— MultiAgentPort 官方文件邮箱实现。
// 文件邮箱 + 轮询唤醒均为本包内部细节，kernel / Task 工具完全不感知。
// 换成基于 Redis/消息队列的实现时，kernel 与 Task 工具零改动。

const POLL_INTERVAL_MS = 500;

class MailboxMultiAgent implements MultiAgentPort {
  private readonly root: string;
  private seq = 0;
  constructor(workDir: string) {
    this.root = join(workDir, ".helios", "mailbox");
  }

  private inboxDir(name: string): string {
    return join(this.root, name.replace(/[^\w.-]/g, "_"), "inbox");
  }

  async spawn(spec: AgentSpec): Promise<AgentHandle> {
    const dir = this.inboxDir(spec.name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(this.root, spec.name.replace(/[^\w.-]/g, "_"), "agent.json"),
      JSON.stringify(spec),
      "utf8",
    );
    return { id: `agent-${spec.name}`, name: spec.name };
  }

  async send(handle: AgentHandle, msg: AgentMessage): Promise<void> {
    const dir = this.inboxDir(handle.name);
    await mkdir(dir, { recursive: true });
    const fname = `${Date.now()}-${this.seq++}.json`;
    await writeFile(join(dir, fname), JSON.stringify(msg), "utf8");
  }

  onMessage(handle: AgentHandle, cb: (msg: AgentMessage) => void): Disposable {
    const dir = this.inboxDir(handle.name);
    let stopped = false;
    const poll = async (): Promise<void> => {
      if (stopped) return;
      let files: string[] = [];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
      } catch {
        return; // 目录尚未创建
      }
      for (const f of files) {
        const full = join(dir, f);
        try {
          const raw = await readFile(full, "utf8");
          await rm(full, { force: true }); // 消费即删除，at-least-once
          cb(JSON.parse(raw) as AgentMessage);
        } catch {
          // 读到写一半的文件等下一轮
        }
      }
    };
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return {
      dispose() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  async dispose(handle: AgentHandle): Promise<void> {
    await rm(join(this.root, handle.name.replace(/[^\w.-]/g, "_")), {
      recursive: true,
      force: true,
    });
  }
}

export const apiVersion = MULTI_AGENT_PORT_API_VERSION;

export function create(ctx: KernelContext): MultiAgentPort {
  return new MailboxMultiAgent(ctx.workDir);
}

export default { apiVersion, create };
