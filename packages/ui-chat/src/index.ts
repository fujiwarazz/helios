// @helios/ui-chat —— 极简 React 对话渲染库。
// 只依赖 IChatClient 契约(见 types.ts),可被跨进程(RpcChatClient)或同进程宿主复用。

export { ChatView } from "./ChatView";
export type { ChatViewProps } from "./ChatView";
export { useChat, reduce, messagesToViews, initialState } from "./useChat";
export type { RenderTool, ChatState, UseChatResult } from "./useChat";
export { RpcChatClient } from "./RpcChatClient";
export type {
  IChatClient,
  ConnectionState,
  ChatMessageView,
  ToolCallView,
} from "./types";
