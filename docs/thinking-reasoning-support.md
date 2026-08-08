# thinking / reasoning 支持：在统一 StreamEvent 上打通两家模型的推理输出

> 基于对 helios 现有实现（`ports/types.ts` / `llm-anthropic` / `llm-openai` / `kernel/session.ts`）的通读。
> 目标：让 helios 能接收、累积、回传模型的 thinking/reasoning 输出，且保持"kernel 无 per-model 分支、差异锁在各 provider 适配层"的既有架构。

---

## 一、动机：当前 thinking 被直接丢弃

helios 现在的多模型兼容是"每个 provider 适配器归一化到统一 `StreamEvent`/`Message`"（见 `ports/types.ts:95` 注释"Anthropic / OpenAI 归一化后的内部统一协议"）。但这套协议里**完全没有 thinking**：

- `StreamEvent`（`types.ts:100-106`）只有 text-delta / tool-call-* / message-stop / error，**没有 thinking 事件**。
- `ContentBlock`（`types.ts:24-27`）只有 text / tool_use / tool_result，**没有 thinking 块**。
- `LLMOptions`（`types.ts:108-116`）没有 thinking/reasoning 开关。
- 两个适配器都不映射 Anthropic 的 `thinking_delta`/`signature_delta`、也不映射 OpenAI 协议的 `reasoning_content`。

后果：
- Claude extended thinking 的思考过程被丢弃；更严重的是**带工具调用的 thinking 轮无法正确回传**——Anthropic 要求续接 tool_result 时，assistant 轮必须原样带回 thinking 块（含 signature），否则 400。
- DeepSeek-R1 类模型的 `reasoning_content` 无处落地。

对照 valos：thinking 在网关层做归一化（`reasoning_content → ThinkingBlock`），且 thinking 块进历史回传、cache_control 不打在其上。helios 要在**适配层**补齐等价能力。

---

## 二、设计：统一协议加"thinking"这一等公民

### 2.1 ports 扩展（`packages/ports/src/types.ts`）

```ts
// ContentBlock 增加 thinking 块（进对话历史，可回传）
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string } // 新增
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; output: unknown; isError?: boolean };

// StreamEvent 增加 thinking 流事件
export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }              // 新增：思考正文增量
  | { type: "thinking-signature"; signature: string }     // 新增：Anthropic 完整性签名（回传必需）
  | { type: "tool-call-start"; id: string; name: string }
  | { type: "tool-call-delta"; id: string; argsDelta: string }
  | { type: "tool-call-end"; id: string }
  | { type: "message-stop"; stopReason: StopReason }
  | { type: "error"; error: string };

// LLMOptions 增加 thinking 开关（provider 侧决定如何落地/忽略）
export interface LLMOptions {
  provider?: string;
  model?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  thinking?: { enabled: boolean; budgetTokens?: number }; // 新增
}
```

> 设计取舍：signature 单独一个事件而非塞进 message-stop——因为 Anthropic 是 `signature_delta` 独立于 thinking 块结束前到达，单独事件让 session 累积逻辑与 text/tool 对称。

### 2.2 llm-anthropic 适配（`convert.ts` + `index.ts`）

- **请求侧开关**（index.ts `messages.create`）：`opts.thinking?.enabled` 为真时传 `thinking: { type: "enabled", budget_tokens: budgetTokens ?? 10000 }`；**并强制不传 temperature**（Anthropic 硬约束：extended thinking 与 temperature 互斥，valos 亦如此）。
- **流式映射**（index.ts，现有 content_block 分发处）：
  - `content_block_delta.thinking_delta` → `{ type: "thinking-delta", text }`
  - `content_block_delta.signature_delta` → `{ type: "thinking-signature", signature }`
  - `redacted_thinking` 块：**当前降级为不透传（静默丢弃）**——统一 StreamEvent 尚无对应事件，opaque 保真透传需新增 StreamEvent/ContentBlock，对罕见场景不成比例，暂不实现（见「已知限制」S2）。
- **历史回传**（convert.ts `toAnthropicBlocks`）：把 helios 的 `thinking` ContentBlock 还原成 Anthropic `thinking` 块（带 signature），且**放在该 assistant 消息内容块的最前面**（Anthropic 要求 thinking 在 text/tool_use 之前）。无 signature 的 thinking 块无法通过校验，直接丢弃（见「已知限制」S1）。
- **cache 断点避让**：当前 main 基线的 llm-anthropic **不含 cache_control 逻辑**（`applyCacheBreakpoints` 是 branch-tree-cache 分支才引入的），故本期无 thinking+cache 冲突、无需处理。⚠️ 待 branch-tree-cache 合并后，需补一句「cache 断点不落在 thinking 块上」（Anthropic 禁止 thinking 块带 cache_control）。

### 2.3 llm-openai 适配（`stream.ts` + `convert.ts`）

- **流式映射**（stream.ts `mapOpenAIStream`）：OpenAI 协议后端把推理放在非标字段 `delta.reasoning_content`（DeepSeek-R1 类扩展）。在 `OpenAIChunk.choices[].delta` 上读 `reasoning_content` → `{ type: "thinking-delta", text }`。无 signature。
- **请求侧**（convert.ts `toOpenAIMessages`/`toAssistant`）：历史里的 thinking 块**丢弃不回传**（多数 OpenAI 兼容后端忽略历史 reasoning，且无 signature 概念）。
- 无请求侧 thinking 开关（是否吐 reasoning 由后端默认策略决定；如需可后续按 provider 注入 extra body，非本期）。

### 2.4 kernel/session 累积（`kernel/src/session.ts` streamAssistant）

- 消费 `thinking-delta`：累积进一个 `thinking` ContentBlock（与 text 块并列，先于 tool_use）。
- 消费 `thinking-signature`：写入该 thinking 块的 `signature`。
- `message_update` 事件已携带原始 StreamEvent，thinking-delta 自然流到消费方（UI），**无需新增 AgentEvent 类型**。
- **空响应判定**：只有 thinking、无 text 无 tool_use 时视为"无有效正文"，`assistantHasContent` 排除 thinking 块。语义为**丢弃该 assistant 消息 + 本 run 正常结束（不重试）**——区别于 valos 的判空重试；helios 暂不引入重试机制，保持最小实现。

### 2.5 消费方 / UI

- `message_update` 里 `thinking-delta` 可被渲染成"思考中"区块；是否展示由消费方决定（可加一个 `hideThinking` 展示开关，只控展示不改历史——对齐 valos）。本期不强制做 UI，只保证事件流通。

---

## 三、任务拆分（建议一个分支收口）

1. **ports**：`ContentBlock` 加 thinking 块；`StreamEvent` 加 thinking-delta / thinking-signature；`LLMOptions` 加 thinking。
2. **llm-anthropic**：请求侧 thinking 开关 + temperature 互斥；流式映射 thinking_delta/signature_delta（redacted_thinking 降级丢弃）；`toAnthropicBlocks` 回传 thinking 块（前置、无签名丢弃）。cache 避让待 branch-tree-cache 合并后补。
3. **llm-openai**：`mapOpenAIStream` 映射 reasoning_content；请求侧丢弃历史 thinking。
4. **kernel/session**：streamAssistant 累积 thinking 块 + signature；`assistantHasContent` 排除 thinking。
5. **测试**：
   - anthropic：opts.thinking.enabled → 请求带 thinking 参数且不带 temperature；`thinking_delta`+`signature_delta` → 累积出带 signature 的 thinking 块。
   - anthropic 回传：含 thinking 的 assistant 历史 → `toAnthropicBlocks` 保留 thinking 块且在最前、无 cache_control。
   - openai：`reasoning_content` chunk → thinking-delta；历史 thinking 不进请求。
   - session：thinking-only 轮被判为无有效正文（不误当正常结束）。

---

## 四、边界与非目标（诚实标注）

- **不引入 tier 路由 / MODEL_MAP / 按档位 thinking budget**。helios 维持 `LLMOptions.thinking` 由调用方显式传；valos 那种"每 tier 一套默认 thinking budget"是独立演进，不在本期。
- **不做 reasoning_effort 数值调强**（仅 enabled + budgetTokens）。
- **OpenAI 协议后端不回传历史 reasoning**（无 signature、后端普遍忽略）。
- **不做 prompt 模拟**：仍假定原生能力。
- 与 `docs/shell-port-and-persistent-cwd.md` 相互独立，可各自单独落地。

---

## 五、已知限制（CR 后如实记录）

- **S1 无签名 thinking + 同轮 tool_use 的 400 边界**：`toAnthropicBlocks` 丢弃无 signature 的 thinking 块。当 thinking 开启且同一 assistant 消息含 tool_use 时，Anthropic 要求 tool_use 前有带 signature 的 thinking 块——若历史 thinking 无 signature（如 OpenAI 路径产出后切到 Anthropic），丢弃会致该轮缺失 thinking → 可能 400。无法伪造 signature，故仅作限制记录；**单 provider 会话不会触发**（signature 必随 thinking 到达）。
- **S2 redacted_thinking 不透传**：`redacted_thinking` 块当前静默丢弃（统一协议无对应事件）。含 tool_use 时同 S1 的 400 边界。opaque 保真透传需新增 StreamEvent/ContentBlock，对罕见场景不成比例，暂降级。
- **N1 单 thinking 块**：本轮所有 thinking-delta 合并为单块、signature 取最后一个；Anthropic interleaved thinking（beta，多块各自 signature）暂不支持。
- **N3 thinking-only = 丢弃 + 正常结束**：不重试（区别于 valos 判空重试）。
