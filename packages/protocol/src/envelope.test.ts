import { describe, it, expect } from "vitest";
import { encode, decode, type Envelope } from "./envelope";

describe("envelope encode/decode", () => {
  it("req 帧 round-trip", () => {
    const env: Envelope = { kind: "req", id: 7, method: "sendMessage", params: { text: "hi" } };
    expect(decode(encode(env))).toEqual(env);
  });

  it("res 帧 round-trip(含 error)", () => {
    const ok: Envelope = { kind: "res", id: 7, result: { a: 1 } };
    expect(decode(encode(ok))).toEqual(ok);
    const err: Envelope = { kind: "res", id: 8, error: { message: "boom", code: "x" } };
    expect(decode(encode(err))).toEqual(err);
  });

  it("evt 帧 round-trip(带 seq/sessionId/channel)", () => {
    const env: Envelope = {
      kind: "evt",
      channel: "session:s1",
      sessionId: "s1",
      seq: 3,
      payload: { type: "agent_end" },
    };
    expect(decode(encode(env))).toEqual(env);
  });

  it("非法 JSON 抛错", () => {
    expect(() => decode("{not json")).toThrow();
  });

  it("未知 kind 抛错", () => {
    expect(() => decode(JSON.stringify({ kind: "nope" }))).toThrow(/未知协议帧/);
  });
});
