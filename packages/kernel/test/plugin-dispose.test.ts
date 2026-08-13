import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AskQuestionRequest, AskQuestionResponse, Logger } from "@helios/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kernel, type Manifest } from "../src/index";
import { disposed, reset } from "./fixtures/disposableCapability";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noAsk = async (_request: AskQuestionRequest): Promise<AskQuestionResponse> => ({
  answers: ["ok"],
});

describe("Kernel plugin disposal", () => {
  let workDir: string;

  beforeEach(async () => {
    reset();
    workDir = await mkdtemp(join(tmpdir(), "helios-plugin-dispose-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("disposes plugin instances in reverse load order and is idempotent", async () => {
    const capability = fixture("disposableCapability.ts");
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("mockLlmTextOnly.ts") },
        { port: "CapabilityProvider", package: capability, options: { id: "first" } },
        { port: "CapabilityProvider", package: capability, options: { id: "second" } },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    kernel.createSession({ askQuestion: noAsk });

    await kernel.dispose();
    await kernel.dispose();

    expect(disposed).toEqual(["second", "first"]);
  });
});
