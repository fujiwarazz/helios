export interface IpcSecurityEvent {
  sender: unknown;
  senderFrame: { url: string } | null;
}

export interface IpcSecurityWindow {
  webContents: {
    mainFrame: unknown;
    getURL(): string;
  };
}

export function assertTrustedIpcEvent(
  event: IpcSecurityEvent,
  window: IpcSecurityWindow,
): void {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame?.url !== window.webContents.getURL()
  ) {
    throw new Error("untrusted Electron IPC sender");
  }
}
