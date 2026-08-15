import type { FileSystemPort } from "@helios/ports";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// 项目指令加载：把仓库自带的规范文件（AGENTS.md 等）注入系统提示词，让 agent 遵循本仓约定。
//
// 为什么不照抄 pi 的「从 cwd 向上遍历祖先目录」：FileSystemPort 被 fs-node 的 WorkDirGuard 锁在
// workDir 内，glob() 还会直接拒绝含 `..` 的 pattern。祖先目录根本读不到，所以 workDir 内的文件走
// Port（尊重 guard、可被替换实现），仅 `~/.helios` 这一个全局位置用 node:fs 直读
// （kernel.ts 读 session meta 已有同样的先例）。

/** workDir 内被识别为项目指令的文件名，按此顺序全部加载（不是"取第一个命中"）。 */
const WORKDIR_INSTRUCTION_FILES = ["AGENTS.md", "HELIOS.md"];

const GLOBAL_INSTRUCTION_FILE = "AGENTS.md";

export interface ProjectInstructionFile {
  path: string;
  content: string;
}

export interface LoadProjectInstructionsOptions {
  fileSystem: FileSystemPort;
  /**
   * 全局指令目录，缺省 `HELIOS_DATA_ROOT` 或 `~/.helios`。
   * 传空串可关闭全局加载（测试用，避免读到开发者本机的真实文件）。
   */
  globalDir?: string;
}

/** 解析全局指令目录。与仓库其它地方的 `~/.helios`（HELIOS_DATA_ROOT）约定一致。 */
export function resolveGlobalInstructionDir(): string {
  return process.env.HELIOS_DATA_ROOT ?? join(homedir(), ".helios");
}

/**
 * 加载项目指令文件，顺序为 broad → specific（全局在前，仓库内在后），
 * 让更具体的规范在冲突时出现在更靠后的位置。任一文件缺失都静默跳过。
 */
export async function loadProjectInstructions(
  opts: LoadProjectInstructionsOptions,
): Promise<ProjectInstructionFile[]> {
  const files: ProjectInstructionFile[] = [];

  const globalDir = opts.globalDir ?? resolveGlobalInstructionDir();
  if (globalDir) {
    const path = join(globalDir, GLOBAL_INSTRUCTION_FILE);
    const content = await readGlobalFile(path);
    if (content) files.push({ path, content });
  }

  for (const name of WORKDIR_INSTRUCTION_FILES) {
    const content = await readWorkDirFile(opts.fileSystem, name);
    if (content) files.push({ path: name, content });
  }

  return files;
}

/**
 * 渲染成 `<project_context>` 包裹块。这套 XML 包裹沿用 pi 的既有做法：路径写进属性，
 * 让模型能引用"这条规则来自哪个文件"。没有任何指令文件时返回空串，调用方据此跳过拼接。
 */
export function renderProjectInstructions(files: ProjectInstructionFile[]): string {
  if (files.length === 0) return "";
  const blocks = files.map(
    (file) => `<project_instructions path="${file.path}">\n${file.content.trim()}\n</project_instructions>`,
  );
  return [
    "<project_context>",
    "Project-specific instructions. These override the default behavior above; follow them exactly.",
    "",
    blocks.join("\n\n"),
    "</project_context>",
  ].join("\n");
}

async function readGlobalFile(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return content.trim() ? content : undefined;
  } catch {
    return undefined; // 不存在 / 不可读：无全局指令，正常情况
  }
}

async function readWorkDirFile(
  fileSystem: FileSystemPort,
  name: string,
): Promise<string | undefined> {
  try {
    if (!(await fileSystem.exists(name))) return undefined;
    const content = await fileSystem.readFile(name);
    return content.trim() ? content : undefined;
  } catch {
    return undefined; // guard 拒绝 / 读失败：不因缺规范文件阻断启动
  }
}
