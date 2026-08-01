// FileSystemPort —— 六件套文件工具的基座能力。
export const FILESYSTEM_PORT_API_VERSION = 1;

export interface FileSystemPort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  glob(pattern: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}
