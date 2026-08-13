import { delimiter, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWebHostConfig } from "./hostConfig";

describe("web Workspace Host config", () => {
  it("defaults to loopback and keeps Code mode disabled", () => {
    expect(parseWebHostConfig({})).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      codeMode: false,
      allowedRoots: [],
    });
  });

  it.each(["0.0.0.0", "::", "192.168.1.2"])(
    "rejects non-loopback bind address %s",
    (host) => {
      expect(() => parseWebHostConfig({ HELIOS_WEB_HOST: host })).toThrow(/loopback/i);
    },
  );

  it("enables Code mode and parses Host directory allowlists", () => {
    const config = parseWebHostConfig({
      HELIOS_CODE_MODE: "1",
      HELIOS_WORKSPACE_ROOTS: ["/tmp/a", "/tmp/b"].join(delimiter),
      HELIOS_DATA_ROOT: "/tmp/helios-data",
      HELIOS_WEB_HOST: "localhost",
      HELIOS_WEB_PORT: "9000",
    });

    expect(config).toEqual({
      host: "localhost",
      port: 9000,
      codeMode: true,
      dataRoot: resolve("/tmp/helios-data"),
      allowedRoots: [resolve("/tmp/a"), resolve("/tmp/b")],
    });
  });
});
