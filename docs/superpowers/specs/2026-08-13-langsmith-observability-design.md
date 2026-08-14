# LangSmith 可观测性接入设计

**日期：** 2026-08-13  
**状态：** 待用户复核  
**范围：** Helios 的 Agent turn、LLM 流式调用和工具执行追踪

## 1. 目标与边界

Helios 将在不改变现有 Agent 行为的前提下，把一轮 Agent 执行记录为 LangSmith 的可检索 trace。每个 trace 可关联到同一次 session，并完整展示：用户 turn、模型调用、工具调用、token 用量、耗时和错误。

本期覆盖：

- 每次 `runTurnLoop` 产生一个根 trace；
- `@helios/llm-anthropic` 与 `@helios/llm-openai` 的流式模型调用产生 `llm` 子 run；
- 工具执行路径产生 `tool` 子 run；
- LangSmith 停用、未配置或上报失败时，主 Agent 路径继续执行。

本期不覆盖：

- 将现有 provider 改为 Claude Agent SDK；Helios 当前已有自己的 Kernel、工具循环和 Anthropic SDK provider，替换执行框架不属于观测性接入范围；
- 持久化 LangSmith API Key、完整敏感环境变量或未经裁剪的文件内容；
- 在浏览器渲染进程中读取或暴露 LangSmith 凭据。

## 2. 方案选择

候选方案：

1. 仅在 provider 包裹 LLM 调用：改动最小，但 Agent turn 和工具调用没有共同父节点。
2. 在 Kernel turn 处建立根 trace，并在 provider/工具路径建立子 run：能表达完整执行树，同时 LangSmith 依赖保持在小范围适配层中。
3. 将追踪写入全局事件系统：覆盖面更大，但会把第三方观测依赖扩散到 Kernel 事件协议。

采用方案 2。它满足完整链路可见性，也允许通过 no-op 实现将外部服务故障与 Agent 执行隔离。

## 3. 架构与追踪树

新增工作区包 `@helios/observability-langsmith`。该包定义一组与 LangSmith SDK 隔离的轻量接口，并提供两种实现：

- `LangSmithTracer`：环境变量有效且 `LANGSMITH_TRACING=true` 时创建 trace/run，并异步结束与上报；
- `NoopTracer`：缺少配置或追踪关闭时不分配网络资源、不产生副作用。

Kernel 只依赖 tracer 接口，LangSmith SDK 仅由新包直接依赖。调用结构如下：

```text
Agent turn (root: chain, helios.agent_turn)
├─ LLM stream (child: llm, helios.llm.stream)
├─ Tool invocation (child: tool, helios.tool.<name>)
└─ LLM stream / tool invocation ...
```

根 trace metadata 包括 `sessionId`、provider、请求模型、工作目录是否存在（不记录绝对路径）和 Helios 版本。LLM run 记录规范化的输入消息、模型、选项、最终 usage、停止原因和错误。Tool run 记录工具名、经截断/脱敏后的入参、结果摘要、耗时和错误。

流式调用在开始网络请求前创建 LLM run，在收到 `message-stop` 或 `error` 事件时结束。若迭代器异常穿透，`finally` 仍以错误状态关闭 run。工具调用同样使用 `try/finally` 结束，因此取消、异常和正常完成都不会留下悬挂 run。

## 4. 配置与安全

服务端（CLI、Electron main process、Web host）通过环境变量配置：

```bash
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_API_KEY=<secret>
LANGSMITH_PROJECT=helios
```

实现提供 `.env.example`，只含键名和安全说明；真实 `.env` 文件必须由 `.gitignore` 忽略。任何配置文件、日志、trace metadata 和测试夹具都不得含 API Key。启动文档说明在运行 Host 进程的环境中设置变量，Electron renderer 不读取这些变量。

用户消息中出现过有效样式的密钥，因此实现交付说明将建议在 LangSmith 控制台轮换该密钥。示例和测试只使用占位值。

## 5. 依赖与包边界

在 `@helios/observability-langsmith` 中增加：

- `langsmith`：`traceable`/client API 与 run 上报；
- `zod`：运行时解析和校验可选观测配置、输入摘要与 metadata。

按请求将 `@anthropic-ai/claude-agent-sdk` 加入工作区依赖清单，但本期不从现有执行链调用它；这样不会让一次观测性改动改变模型执行语义。若未来引入 Claude Agent SDK runtime，将由该 runtime 复用此 tracer 接口，保持 LangSmith 结构一致。

## 6. 错误处理与数据控制

- Tracing 初始化失败时回退到 `NoopTracer`，不使 Host 启动失败。
- 每一次 `start`、`end`、`error` 上报均捕获并吞掉观测 SDK/网络异常，同时可在 debug 日志中给出无敏感信息的诊断。
- 输入、工具参数和输出按字段白名单及最大长度裁剪；二进制内容、文件全文、API Key、Authorization/Cookie 字段和超长文本不发送。
- 用量只发送已经由 provider 规范化的 token 数；不通过解析供应商原始响应补偿。
- 取消会结束现有 run 并标记为 cancelled/error；不会为了送达追踪而延长取消或阻塞进程退出。

## 7. 测试策略

1. `@helios/observability-langsmith` 单元测试：环境开关、缺失配置降级、配置解析、脱敏/截断和上报异常吞没。
2. Kernel 测试：一轮 turn 建立根 trace，多个 LLM/工具调用继承同一父 trace，取消和异常也会关闭 run。
3. Provider 测试：正常结束、供应商错误和迭代器异常均写出正确的 LLM 终态和 usage。
4. 回归测试：未设置任何 `LANGSMITH_*` 变量时，现有所有 Agent/LLM 测试行为与输出不变。

测试通过注入内存 tracer 断言 run 树，不访问真实 LangSmith 服务，也不使用真实凭据。

## 8. 验收标准

- 配置有效时，一次含工具调用的 Agent turn 在 `helios` 项目中显示一棵根 turn、LLM 与 tool 子 run 的 trace 树。
- trace 显示模型、token usage、停止原因、工具名、耗时和错误状态。
- 未配置/关闭追踪或 LangSmith 不可达时，Helios 仍能完成同一 turn。
- API Key 不出现在 Git 跟踪文件、日志、测试数据或 LangSmith 输入/metadata 中。
- 新增和受影响包的 typecheck、定向测试及全量测试通过。
