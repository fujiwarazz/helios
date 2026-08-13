import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, sep } from "node:path";
import { WorkspacePaths } from "./paths";
import type { EditRecord } from "./types";

export interface LocalEditRecordStoreOptions {
  maxRecordBytes?: number;
  warn?: (message: string) => void;
}

export class LocalEditRecordStore {
  private readonly maxRecordBytes: number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly paths: WorkspacePaths,
    options: LocalEditRecordStoreOptions = {},
  ) {
    this.maxRecordBytes = options.maxRecordBytes ?? 1024 * 1024;
    this.warn = options.warn ?? (() => undefined);
  }

  async append(record: EditRecord): Promise<void> {
    validateRecord(record);
    const row = JSON.stringify(record);
    if (Buffer.byteLength(row, "utf8") > this.maxRecordBytes) {
      throw new Error(`edit record is too large (limit ${this.maxRecordBytes} bytes)`);
    }
    const file = this.paths.editLog(record.sessionId);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${row}\n`, "utf8");
  }

  async list(sessionId: string): Promise<EditRecord[]> {
    const file = this.paths.editLog(sessionId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: EditRecord[] = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const record = JSON.parse(line) as EditRecord;
        validateRecord(record);
        if (record.sessionId !== sessionId) throw new Error("session id mismatch");
        records.push(record);
      } catch (error) {
        this.warn(`skipping corrupt edit record: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return records;
  }
}

function validateRecord(record: EditRecord): void {
  if (record.schemaVersion !== 1) throw new Error("unsupported edit record schema version");
  if (!record.id || !record.sessionId || !record.workspaceId || !record.rootId || !record.toolUseId) {
    throw new Error("edit record identity is incomplete");
  }
  assertSafeRelativePath(record.relativePath);
}

function assertSafeRelativePath(path: string): void {
  const normalized = normalize(path);
  if (
    !path ||
    isAbsolute(path) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    path.includes("\0")
  ) {
    throw new Error(`invalid relative path: ${JSON.stringify(path)}`);
  }
}
