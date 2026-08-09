// apps/web/server/host.ts —— Node WS 宿主进程(tsx 运行)。
// 读根 helios.config.json 起真实 Kernel(默认 llm-openai + codexapis.com 网关),
// 用 @helios/host 把每个 WS 连接绑到一个 Kernel Session。对应 valos 的 RemoteControlServer。
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Kernel, type Manifest } from "@helios/kernel";
import { serveKernelOverWs } from "@helios/host";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL("../../../helios.config.json", import.meta.url));
const PORT = Number(process.env.HELIOS_WEB_PORT ?? 8787);

async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw) as Manifest;
}

async function main(): Promise<void> {
  const manifest = await loadManifest();
  const kernel = new Kernel({
    workDir: REPO_ROOT,
    manifest,
    llmOptions: { provider: "openai" },
    // 裸包名从本 app 依赖解析(manifest 里的 @helios/* 是 @helios/web 的 workspace 依赖)。
    resolvePackage: (spec) => import.meta.resolve(spec),
  });
  await kernel.start();

  const handle = await serveKernelOverWs({ kernel, port: PORT });
  console.info(
    `helios web 宿主就绪：ws://localhost:${handle.port}  工具=[${kernel.listTools().join(", ")}]`,
  );
  // 默认端口(8787)前端已内置,直接开干净 URL;非默认端口才需 ?ws= 覆盖。
  const open =
    handle.port === 8787
      ? "http://localhost:5173/"
      : `http://localhost:5173/?ws=ws://localhost:${handle.port}`;
  console.info(`浏览器打开：${open}`);

  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
