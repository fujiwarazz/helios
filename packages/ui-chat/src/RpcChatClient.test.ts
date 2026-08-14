import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@helios/protocol/browser";
import { RpcChatClient } from "./RpcChatClient";

describe("RpcChatClient", () => {
  it("getHistory 请求完整展示历史而不是压缩后的 LLM 上下文", async () => {
    const call = vi.fn().mockResolvedValue([]);
    const client = new RpcChatClient({ call } as unknown as RpcClient);

    await client.getHistory();

    expect(call).toHaveBeenCalledWith("displayHistory");
  });

  it("sendMessage 禁用普通 RPC 的默认超时，允许长时间 Agent 运行", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const client = new RpcChatClient({ call } as unknown as RpcClient);

    await client.sendMessage("分析这个仓库");

    expect(call).toHaveBeenCalledWith(
      "sendMessage",
      { text: "分析这个仓库" },
      { timeoutMs: 0 },
    );
  });

  it("分支操作用默认超时（纯 HEAD 移动，不驱动 Agent，不该禁用超时）", async () => {
    const call = vi.fn().mockResolvedValue([]);
    const client = new RpcChatClient({ call } as unknown as RpcClient);

    await client.listBranches();
    await client.switchBranch("msg_leaf");

    // 第三个参数（options）不传 → 沿用 RpcClient 的默认超时
    expect(call).toHaveBeenNthCalledWith(1, "listBranches");
    expect(call).toHaveBeenNthCalledWith(2, "switchBranch", { leafId: "msg_leaf" });
  });
});
