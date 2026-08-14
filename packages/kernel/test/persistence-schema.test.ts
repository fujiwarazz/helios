import { describe, it, expect } from "vitest";
import {
  parseJsonLines,
  assertSchemaVersion1,
  isPlainObject,
  UnsupportedSchemaVersionError,
} from "../src/persistence/schema";

interface Rec {
  schemaVersion: 1;
  value: string;
}

function collect(): { calls: string[]; onCorrupt: (line: string) => void } {
  const calls: string[] = [];
  return { calls, onCorrupt: (line: string) => calls.push(line) };
}

describe("persistence/schema —— JSONL 解析与版本校验", () => {
  it("解析合法 v1 行，忽略空行", () => {
    const { calls, onCorrupt } = collect();
    const raw = `{"schemaVersion":1,"value":"a"}\n\n{"schemaVersion":1,"value":"b"}\n`;
    const out = parseJsonLines<Rec>(raw, { kind: "test", onCorrupt });
    expect(out.map((r) => r.value)).toEqual(["a", "b"]);
    expect(calls).toEqual([]);
  });

  it("缺 schemaVersion 的行视为 1 并补齐字段", () => {
    const { calls, onCorrupt } = collect();
    const out = parseJsonLines<Rec>(`{"value":"legacy"}\n`, { kind: "test", onCorrupt });
    expect(out).toEqual([{ schemaVersion: 1, value: "legacy" }]);
    expect(calls).toEqual([]);
  });

  it("未知 schemaVersion 抛错且不进 onCorrupt（fail loud，不静默降级）", () => {
    const { calls, onCorrupt } = collect();
    expect(() =>
      parseJsonLines<Rec>(`{"schemaVersion":2,"value":"future"}\n`, { kind: "test", onCorrupt }),
    ).toThrow(/unsupported test schema version 2/i);
    expect(calls).toEqual([]);
  });

  it("坏 JSON / 半行走 onCorrupt 并跳过，不影响其余行", () => {
    const { calls, onCorrupt } = collect();
    const raw = `{"schemaVersion":1,"value":"ok"}\n{"schemaVersion":1,"val`;
    const out = parseJsonLines<Rec>(raw, { kind: "test", onCorrupt });
    expect(out.map((r) => r.value)).toEqual(["ok"]);
    expect(calls).toHaveLength(1);
  });

  it("非对象行（数组/标量）走 onCorrupt", () => {
    const { calls, onCorrupt } = collect();
    const out = parseJsonLines<Rec>(`[1,2]\n42\n"str"\n`, { kind: "test", onCorrupt });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("assertSchemaVersion1 / isPlainObject 基础行为", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(() => assertSchemaVersion1("k", { schemaVersion: 1 })).not.toThrow();
    expect(() => assertSchemaVersion1("k", {})).not.toThrow();
    try {
      assertSchemaVersion1("k", { schemaVersion: 9 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaVersionError);
      expect((error as UnsupportedSchemaVersionError).found).toBe(9);
    }
  });
});
