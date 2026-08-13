import { randomUUID } from "node:crypto";
import { Client } from "langsmith";
import { z } from "zod";

export type TraceRunType = "chain" | "llm" | "tool";
export type TraceStatus = "success" | "error" | "cancelled";

export interface TraceInput {
  name: string;
  runType: TraceRunType;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface TraceResult {
  status: TraceStatus;
  output?: unknown;
  error?: unknown;
}

export interface TraceRun {
  startChild(input: TraceInput): TraceRun;
  end(result: TraceResult): Promise<void>;
}

export interface Tracer {
  startRun(input: TraceInput): TraceRun;
}

interface LangSmithClient {
  createRun(run: Record<string, unknown>): Promise<unknown>;
  updateRun(runId: string, run: Record<string, unknown>): Promise<unknown>;
}

interface TracerDependencies {
  client?: LangSmithClient;
  now?: () => Date;
}

const envSchema = z.object({
  LANGSMITH_TRACING: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().url().optional(),
  LANGSMITH_API_KEY: z.string().min(1).optional(),
  LANGSMITH_PROJECT: z.string().min(1).optional(),
});

const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 8_192;
const MAX_COLLECTION_ENTRIES = 100;
const sensitiveKey = /^(?:api[_-]?key|authorization|cookie|password|secret|access[_-]?token|auth[_-]?token)$/i;

/**
 * 从宿主环境创建 LangSmith tracer。无配置或配置无效时回退为 no-op，
 * 任何上报错误都会被吞掉，绝不影响 Agent 的实际执行路径。
 */
export function createLangSmithTracer(
  env: NodeJS.ProcessEnv = process.env,
  deps: TracerDependencies = {},
): Tracer {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success || parsed.data.LANGSMITH_TRACING !== "true" || !parsed.data.LANGSMITH_API_KEY) {
    return noopTracer;
  }

  const client =
    deps.client ??
    (new Client({
      apiKey: parsed.data.LANGSMITH_API_KEY,
      apiUrl: parsed.data.LANGSMITH_ENDPOINT,
    }) as unknown as LangSmithClient);
  const projectName = parsed.data.LANGSMITH_PROJECT ?? "default";
  return new LangSmithTracer(client, projectName, deps.now ?? (() => new Date()));
}

class LangSmithTracer implements Tracer {
  constructor(
    private readonly client: LangSmithClient,
    private readonly projectName: string,
    private readonly now: () => Date,
  ) {}

  startRun(input: TraceInput): TraceRun {
    return this.createRun(input, undefined, undefined, undefined);
  }

  private createRun(
    input: TraceInput,
    parentRunId: string | undefined,
    traceId: string | undefined,
    parentDottedOrder: string | undefined,
  ): TraceRun {
    const id = randomUUID();
    const currentTraceId = traceId ?? id;
    const startTime = this.now().getTime();
    const dottedOrder = [parentDottedOrder, dottedOrderSegment(startTime, id)].filter(Boolean).join(".");
    void ignoreFailures(
      this.client.createRun({
        id,
        trace_id: currentTraceId,
        parent_run_id: parentRunId,
        dotted_order: dottedOrder,
        name: input.name,
        run_type: input.runType,
        project_name: this.projectName,
        inputs: sanitize(input.input),
        extra: { metadata: sanitize(input.metadata ?? {}) },
        start_time: startTime,
      }),
    );

    return {
      startChild: (child) => this.createRun(child, id, currentTraceId, dottedOrder),
      end: async (result) => {
        await ignoreFailures(
          this.client.updateRun(id, {
            end_time: this.now().getTime(),
            outputs: sanitize(result.output),
            error: result.error === undefined ? undefined : stringifyError(result.error),
            extra: { metadata: { status: result.status } },
          }),
        );
      },
    };
  }
}

const noopRun: TraceRun = {
  startChild: () => noopRun,
  end: async () => {},
};

const noopTracer: Tracer = {
  startRun: () => noopRun,
};

function ignoreFailures(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

function sanitize(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return REDACTED;
  if (typeof value === "string") return truncate(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: truncate(value.message) };
  if (Array.isArray(value)) return value.slice(0, MAX_COLLECTION_ENTRIES).map((item) => sanitize(item));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_COLLECTION_ENTRIES);
    return Object.fromEntries(entries.map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey)]));
  }
  if (value === undefined) return undefined;
  return truncate(String(value));
}

function truncate(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH - 1)}…` : value;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dottedOrderSegment(startTime: number, runId: string): string {
  const timestamp = `${new Date(startTime).toISOString().slice(0, -1)}001Z`;
  return timestamp.replace(/[-:.]/g, "") + runId;
}
