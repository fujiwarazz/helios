import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export interface WebHostConfig {
  host: string;
  port: number;
  codeMode: boolean;
  dataRoot: string;
  allowedRoots: string[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function parseWebHostConfig(
  env: Record<string, string | undefined>,
): WebHostConfig {
  const host = env.HELIOS_WEB_HOST || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("HELIOS_WEB_HOST must be a loopback address for local Code mode");
  }

  const port = Number(env.HELIOS_WEB_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("HELIOS_WEB_PORT must be an integer between 0 and 65535");
  }

  return {
    host,
    port,
    codeMode: env.HELIOS_CODE_MODE === "1",
    dataRoot: resolve(env.HELIOS_DATA_ROOT ?? join(homedir(), ".helios")),
    allowedRoots: (env.HELIOS_WORKSPACE_ROOTS ?? "")
      .split(delimiter)
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => resolve(path)),
  };
}
