import cron, { type ScheduledTask } from "node-cron";
import type {
  CapabilityProvider,
  Tool,
  KernelContext,
  Logger,
} from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

/**
 * @helios/cap-cron —— CapabilityProvider 的定时任务实现（P2）。
 *
 * 暴露三个工具（带 `cron` 前缀由 ToolRegistry 统一加）：
 * - cron_schedule：按 crontab 表达式登记一个定时任务
 * - cron_list：列出所有已登记任务及触发次数
 * - cron_cancel：按 id 取消任务
 *
 * 触发动作在最小实现里只做记数 + 日志（真实系统可在此向会话回投消息）。
 * 降级：不加载 → agent 无定时能力，其余照常。
 */
interface Job {
  id: string;
  cronExpr: string;
  note: string;
  task: ScheduledTask;
  fireCount: number;
}

class CronCapability implements CapabilityProvider {
  readonly name = "cron";
  private readonly jobs = new Map<string, Job>();
  private seq = 0;
  private logger: Logger | undefined;

  activate(ctx: KernelContext): void {
    this.logger = ctx.logger;
  }

  getTools(): Tool[] {
    return [this.scheduleTool(), this.listTool(), this.cancelTool()];
  }

  private scheduleTool(): Tool {
    return {
      name: "schedule",
      description: "按 crontab 表达式登记一个定时任务，返回任务 id。支持秒级（6 段）表达式。",
      inputSchema: {
        type: "object",
        properties: {
          cron: { type: "string", description: "crontab 表达式，如 '*/5 * * * *'" },
          note: { type: "string", description: "任务备注" },
        },
        required: ["cron"],
      },
      execute: async (input) => {
        const { cron: expr, note } = input as { cron: string; note?: string };
        if (!cron.validate(expr)) {
          return { output: `非法的 cron 表达式：${expr}`, isError: true };
        }
        const id = `job_${++this.seq}`;
        const job: Job = { id, cronExpr: expr, note: note ?? "", task: undefined as never, fireCount: 0 };
        job.task = cron.schedule(expr, () => {
          job.fireCount++;
          this.logger?.debug(`cron 任务 ${id} 触发（第 ${job.fireCount} 次）：${job.note}`);
        });
        this.jobs.set(id, job);
        return { output: `已登记定时任务 ${id}（${expr}）` };
      },
    };
  }

  private listTool(): Tool {
    return {
      name: "list",
      description: "列出所有已登记的定时任务。",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        const items = [...this.jobs.values()].map((j) => ({
          id: j.id,
          cron: j.cronExpr,
          note: j.note,
          fireCount: j.fireCount,
        }));
        return { output: JSON.stringify(items) };
      },
    };
  }

  private cancelTool(): Tool {
    return {
      name: "cancel",
      description: "按 id 取消一个定时任务。",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      execute: async (input) => {
        const { id } = input as { id: string };
        const job = this.jobs.get(id);
        if (!job) return { output: `未找到任务：${id}`, isError: true };
        job.task.stop();
        this.jobs.delete(id);
        return { output: `已取消定时任务 ${id}` };
      },
    };
  }

  dispose(): void {
    for (const job of this.jobs.values()) job.task.stop();
    this.jobs.clear();
  }
}

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;

export function create(_ctx: KernelContext): CapabilityProvider {
  return new CronCapability();
}

export default { apiVersion, create };
