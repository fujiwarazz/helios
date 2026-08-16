import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CLI_PACKAGE_DIR = join(REPO_ROOT, "apps", "cli");
const CLI_ENTRY = join(CLI_PACKAGE_DIR, "src", "index.ts");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI manifest discovery", () => {
  it("finds the repository manifest when pnpm starts the CLI from apps/cli", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "helios-cli-config-"));
    temporaryRoots.push(dataRoot);
    const output = await startUntilReady(dataRoot);

    expect(output).toContain("MemoryPort");
  });
});

function startUntilReady(dataRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [CLI_ENTRY], {
      cwd: CLI_PACKAGE_DIR,
      env: { ...process.env, HELIOS_DATA_ROOT: dataRoot },
    });
    let output = "";
    let ready = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI did not become ready. Output:\n${output}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (!ready && output.includes("helios CLI 就绪")) {
        ready = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timeout);
      if (ready) resolve(output);
    });
  });
}
