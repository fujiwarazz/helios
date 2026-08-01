# 代码检查发现 + cwd 保护隔离设计

> 基于对 helios 现有实现(tools.ts / fs-node / kernel.ts / cap-lsp / checkpoint-* / teams-mailbox)的通读。
> 决策档位:威胁模型=**防恶意(不可信输入)**;Bash=**PreToolUse 人审**;隔离形态=**可插拔 PathGuard**。
> ⚠️ 见第三节"档位矛盾说明"——所选组合中"防恶意 + 仅人审"不自洽,本文给出分层落地与诚实的边界标注。

---

## 一、代码检查发现(按严重程度)

### 严重 —— cwd 隔离当前形同虚设
- `fs-node/src/index.ts:13` `abs()`:绝对路径直接放行,相对路径 `resolve` 后**不校验是否越界**。→ `Read /etc/passwd`、`Write ~/.ssh/authorized_keys` 全部可过。
- `fs-node/src/index.ts:27` `glob()`:pattern 可写 `../../**`,`cwd:workDir` 挡不住 `..`。
- `builtin/tools.ts:22` Bash:`shell:true` 直接执行 LLM 给的字符串,`cwd` 只定相对基准,命令内绝对路径 / `cd /` / `rm -rf ~` 全部可过。
- **结论**:"限制在 workDir 内"这个隐含契约当前完全不成立。

### 中 —— cancel 不生效(ctx.signal 全程被忽略)
- `types.ts:78` `ToolContext.signal?` 有定义,但 `session.ts:216` 创建 toolCtx 时**未传 signal**;Bash(execa)、WebFetch(fetch)均未消费。
- 后果:JSON-RPC 的 `cancel` 方法对已在执行的长命令 / 卡住的 fetch 无效,失控命令无法叫停(功能 + 安全双重问题)。

### 中 —— WebFetch 无超时 / 无大小限制 / 无 SSRF 防护
- `builtin/tools.ts:176` `fetch(url)`:无 timeout、无 redirect 限制;`slice(50000)` 在**读完整个 body 之后**才截断(内存已被打满)。
- 可 fetch `http://169.254.169.254/`(云元数据)、`http://localhost:*`(内网服务)→ 典型 SSRF。

### 中 —— Bash timeout 无上限
- `builtin/tools.ts:25` `timeout ?? 120_000`:LLM 可传 `timeout: 999999999`,无硬上限。

### 低 —— Grep 读二进制文件做正则
- `builtin/tools.ts:150`:对 glob 到的每个文件 `readFile(...,'utf8')`,遇大二进制 → 内存 + 乱码匹配(轻微 DoS)。

### 低 —— Edit 大文件 split 内存放大
- `builtin/tools.ts:94` `content.split(old_string)`:大文件 + 短 old_string → 巨数组。边界情形。

### 低 —— cap-lsp workDir 默认值隐患
- `cap-lsp/src/index.ts:40` `private workDir = process.cwd()`:activate 未正确调用时会落到进程 cwd。

### 正面观察(可作参照)
- `checkpoint-fs/index.ts:23` / `checkpoint-git`:快照存 `tmpdir()` 而非 workDir 内,git 用独立影子 git-dir 不碰用户 `.git`。**全项目隔离意识最好的地方**,其余隔离可参照其思路。

---

## 二、cwd 保护隔离方案

### 核心原则:隔离落在底层实现,不落在工具层
现状漏因:Read/Write/Edit/Glob 经 FileSystemPort 落地但**校验不在 Port 里**,Bash 干脆绕过 Port。隔离必须收在"底层实现"这一层,散在各工具里必漏。

### 形态:可插拔 PathGuard(契合"一切可替换"哲学)
不新增 Port,给 fs-node 和 Bash 注入一个 guard:

```ts
interface PathGuard {
  assertAllowed(absPath: string, op: 'read' | 'write'): void;  // 越界即 throw
}
```
- `WorkDirGuard`(默认):限制在 workDir。
- `NoopGuard`:全放行(用户显式要全盘访问)。
- 未来:白名单多目录、只读区/可写区分离、realpath 严格版。

"隔离多严"变成实现选择,不动 kernel。

### 第一条线:FileSystemPort 路径归一化 + 越界断言(补 fs-node)
```ts
private abs(path: string): string {
  const full = isAbsolute(path) ? path : resolve(this.workDir, path);
  const rel = relative(this.workDir, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界,拒绝访问 workDir 之外: ${path}`);
  }
  this.guard.assertAllowed(full, op);  // 交给可插拔 guard 做进一步策略
  return full;
}
```
要点(各对应一类攻击):
1. **先 resolve 再 relative**,不能用字符串 `startsWith(workDir)` —— `resolve` 会折叠 `../`,否则 `/workdir/../workdir-evil` 前缀欺骗会误判合法。
2. **符号链接**是纯路径校验的漏网点:workDir 内软链指向外部时 resolve 不解析软链会放行。**防恶意档必须用 `fs.realpath` 解析后再校验**;write 新文件时对**父目录**做 realpath 校验(文件尚不存在)。
3. **glob** 同样过校验:禁止 pattern 含 `..`,或对结果逐条 `abs()` 过滤。

### 第二条线:Bash(最难,shell 命令无法静态解析路径)
`cwd:workDir` 只定相对基准,挡不住命令内绝对路径 / `cd /`。三档:
1. **黑名单/模式拦截(弱)**:正则扫 `rm -rf /`、绝对路径等。`$(echo /et''c/passwd)` 类绕过无穷,**不能当安全边界**,只拦白痴错误。
2. **PreToolUse 人审(务实,本期选择)**:Bash 默认走 `PreToolUse → ask`,危险命令弹用户确认。复用已有 hook 机制,成本最低。**注意:这是"防误操作"档的手段,不是"防恶意"的技术边界(见第三节)。**
3. **OS 级沙箱(治本)**:sandbox-exec(macOS)/ bwrap(Linux)/ 容器,内核层把 fs 限制在 workDir。**唯一对"防恶意"可靠的边界。** 对应 plan 第十一节"云沙箱/SSH(经 FileSystemPort + 未来 backend Port 预留)"。

---

## 三、⚠️ 档位矛盾说明(必读)

**所选组合"威胁模型=防恶意" + "Bash=仅人审"不自洽:**
- 若真防恶意(prompt injection / 跑不可信代码),人审挡不住——恶意命令可伪装成 `npm install`(postinstall 脚本)、`make`(Makefile 调用),用户点"允许"即沦陷。
- 且 FileSystemPort 锁死、Bash 却能 `cat /etc/passwd` = "门上三把锁,旁边墙是纸糊的"。
- **防恶意的唯一可靠边界是 OS 级沙箱**,人审只属"防误操作"档。

**因此本文的落地按"诚实分层":**
- **近期(不引入沙箱)**:把"防误操作"档做扎实 —— FS relative+realpath 严格校验、Bash 走 PreToolUse 人审、修掉 signal/WebFetch/timeout。这解决当前"完全没有边界"的问题。
- **兑现"防恶意"**:必须补 OS 沙箱(sandbox-exec/bwrap/容器),通过 PathGuard + 未来 sandbox 适配点预留。**在补上沙箱之前,不对外声称"可安全运行不可信代码"。**

---

## 四、连带要修的高危项(与隔离同批)
1. **signal 贯通**:session 创建 toolCtx 时传入 run 的 AbortSignal;Bash 的 execa 传 `signal`,WebFetch 的 fetch 传 `signal` + timeout。→ cancel 真正生效。
2. **WebFetch 加固**:超时(如 15s)、限制 redirect、限制响应大小(边读边截,不读全 body)、SSRF 黑名单(禁 `169.254.169.254`、`localhost`、私有网段)。
3. **Bash timeout 硬上限**:`Math.min(input.timeout ?? 120000, 600000)`。
4. **Grep 跳过二进制**:读前判断 null 字节或按扩展名跳过。

---

## 五、落地顺序建议
1. PathGuard 接口 + WorkDirGuard 默认实现,注入 fs-node → FS 越界立即被堵(最高危、影响最大)。
2. signal 贯通 + WebFetch 加固 + Bash timeout 上限(高危,一批修)。
3. Bash 走 PreToolUse 人审(防误操作档)。
4. realpath 严格校验(防软链)。
5. OS 沙箱适配(兑现"防恶意",单独立项,跨平台)。

安全网:每项配 vitest —— 越界路径被拒、`..` glob 被拒、软链越界被拒、cancel 中断长命令、SSRF 目标被拒。
