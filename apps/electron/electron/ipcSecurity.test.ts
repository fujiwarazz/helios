import { describe, expect, it } from "vitest";
import { assertTrustedIpcEvent } from "./ipcSecurity";

describe("Electron privileged IPC security", () => {
  it("accepts only the intended window main frame at its current URL", () => {
    const mainFrame = { url: "file:///app/index.html" };
    const webContents = { mainFrame, getURL: () => mainFrame.url };
    const window = { webContents };

    expect(() =>
      assertTrustedIpcEvent({ sender: webContents, senderFrame: mainFrame }, window),
    ).not.toThrow();
    expect(() =>
      assertTrustedIpcEvent(
        { sender: { mainFrame, getURL: () => mainFrame.url }, senderFrame: mainFrame },
        window,
      ),
    ).toThrow(/untrusted/i);
    expect(() =>
      assertTrustedIpcEvent(
        { sender: webContents, senderFrame: { url: "https://evil.example" } },
        window,
      ),
    ).toThrow(/untrusted/i);
  });
});
