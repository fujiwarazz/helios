import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(async () => undefined),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: mocks.send,
    on: mocks.on,
    removeListener: mocks.removeListener,
  },
}));

beforeAll(async () => {
  await import("./preload");
});

describe("electron preload workspace API", () => {
  it("exposes only a parameterless native directory selector", async () => {
    const call = mocks.expose.mock.calls.find(([name]) => name === "heliosDesktop");
    expect(call).toBeTruthy();
    const api = call?.[1] as Record<string, (...args: unknown[]) => unknown>;
    expect(Object.keys(api)).toEqual(["selectAndImportDirectory"]);

    await api.selectAndImportDirectory();
    expect(mocks.invoke).toHaveBeenCalledWith("helios:select-and-import-directory");
  });
});
