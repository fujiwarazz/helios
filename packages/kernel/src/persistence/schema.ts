// ============================================================================
// packages/kernel/src/persistence/schema.ts
// 持久化 schema 校验与 JSONL 解析的单一真源。
//
// 在此之前，schemaVersion 检查与 JSONL 逐行解析在三处各写了一遍（session.ts 的
// parseTurnRecord/parseCompaction、workspace 的 legacySessionMigrator、sessionCatalog），
// 错误类型与容错口径互不一致。本模块收口这套规则，供 kernel 与 workspace 共用
// （依赖方向 workspace → kernel）。
// ============================================================================

/**
 * 读到「是我们的格式，但版本我们不认识」时抛出。
 * 与「坏行/半行」区别对待：坏行可跳过，未知版本必须 fail loud —— 静默降级会让
 * 来自未来版本的数据被当成缺失，从而在下一次写入时被覆盖丢失。
 */
export class UnsupportedSchemaVersionError extends Error {
  constructor(
    readonly kind: string,
    readonly found: unknown,
  ) {
    super(`unsupported ${kind} schema version ${String(found)}`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验 schemaVersion 为 1。缺字段视为 1（v0 数据没有该字段，读侧按 1 处理，
 * 下次写入时自然补上），其它值一律抛 UnsupportedSchemaVersionError。
 */
export function assertSchemaVersion1(kind: string, value: Record<string, unknown>): void {
  if ("schemaVersion" in value && value.schemaVersion !== 1) {
    throw new UnsupportedSchemaVersionError(kind, value.schemaVersion);
  }
}

export interface ParseJsonLinesOptions {
  /** 出现在错误信息里的记录种类名，如 "session log"。 */
  kind: string;
  /** 单行解析失败的回调（调用方通常 logger.warn 后跳过）。 */
  onCorrupt(line: string, error: unknown): void;
}

/**
 * 逐行解析 JSONL。空行跳过；单行坏（JSON 语法错/非对象）交给 onCorrupt 后跳过 ——
 * 这同时覆盖了「崩溃导致最后一行只写了一半」的情形。
 * UnsupportedSchemaVersionError 不进 onCorrupt，直接向上抛。
 */
export function parseJsonLines<T>(raw: string, opts: ParseJsonLinesOptions): T[] {
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isPlainObject(value)) throw new Error(`${opts.kind} record must be an object`);
      assertSchemaVersion1(opts.kind, value);
      out.push({ ...value, schemaVersion: 1 } as T);
    } catch (error) {
      if (error instanceof UnsupportedSchemaVersionError) throw error;
      opts.onCorrupt(line, error);
    }
  }
  return out;
}
