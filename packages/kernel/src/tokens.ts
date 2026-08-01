// 纪律一：每个 token 的类型参数必须指向 @helios/ports 定义的独立 Port 接口，
// 严禁用具体实现类当契约。
import type {
  FileSystemPort,
  MemoryPort,
  MultiAgentPort,
  CompactStrategyPort,
  CheckpointPort,
} from "@helios/ports";
import { createServiceToken } from "./serviceCollection";

export const IFileSystemPort = createServiceToken<FileSystemPort>("FileSystemPort");
export const IMemoryPort = createServiceToken<MemoryPort>("MemoryPort");
export const IMultiAgentPort = createServiceToken<MultiAgentPort>("MultiAgentPort");
export const ICompactPort = createServiceToken<CompactStrategyPort>("CompactStrategyPort");
export const ICheckpointPort = createServiceToken<CheckpointPort>("CheckpointPort");
