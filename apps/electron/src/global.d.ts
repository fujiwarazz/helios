// apps/electron/src/global.d.ts —— preload 暴露到 window 上的最小 IPC 面的类型声明。
//
// ⚠️ 下面这行 /// <reference> 是必须的:renderer tsconfig 的 "types" 只列了 react/react-dom,
// 但 @helios/kernel 的 package.json "exports" 直接指向源码 .ts(不是预编译 .d.ts),类型解析会
// 透传进 kernel 内部用到 node:path/node:fs 等的文件(如 kernel.ts/session.ts)。这些模块声明来自
// @types/node 的 ambient 声明,一旦在程序里的任意一个文件里被引用就对整个程序生效——apps/web 目前
// 因为多包含了一个引入 vitest/@testing-library 的测试文件而"意外"拿到了同样效果,这里改为显式声明,
// 不依赖那个偶然触发点。真正跑在浏览器/渲染进程里的代码本身不会用到任何 node: API。
/// <reference types="node" />

import type { ElectronIpcBridge } from "@helios/protocol/browser";

export interface ElectronConnectRequest {
  connectionId: string;
  resumeSessionId?: string;
}

declare global {
  interface Window {
    /** preload.ts 通过 contextBridge 暴露;形状 = ElectronIpcBridge + connect()。 */
    helios: ElectronIpcBridge & {
      connect(req: ElectronConnectRequest): Promise<void>;
    };
  }
}

export {};
