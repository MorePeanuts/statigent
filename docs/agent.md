# EDA 智能体

EDA 使用持久 Docker Python 会话。配置和示例位于 `configs/models.json` 与 `configs/tasks/synthetic-eda.json`。这不是正式 Benchmark 协议或模型能力对比。

## 配置

任务中的 `organization` 可为 `single`（缺省）或 `planner-executor`。后者使用独立的规划者、执行者上下文，两者使用同一个所选模型 profile；CLI `--model` 同时覆盖两者。所有角色与子任务共用 `budget`，模型次数、token、执行次数和时限不因角色切换重置，不为两个角色各复制一份额度。未知组织方式会在调用前被拒绝。

模型文件是具名 profile 数组；CLI `--model` 优先于任务的 `model_profile`，`--models` 选择整个模型配置文件。任务参数覆盖内置默认值；未知字段、空目标、越界输入、非法预算及不支持的参数组合在调用前失败，不自动降级。

模型必填 `id/provider/protocol/base_url/model/display_name/api_key_env/capabilities/generation`。`model` 是实际请求标识；`display_name` 仅展示。`provider` 支持 `deepseek` 和 `generic`，协议仅 `chat-completions`。通用提供商支持非流式文本和函数工具，不能假设任意兼容接口的全部功能均适用。自定义模型通过新增 profile 选择，无需改智能体。

DeepSeek 示例请求 `deepseek-flash`，展示 DeepSeek-V4.1-Flash；别名不保证底层权重固定。记录请求及返回模型名、时间和可用指纹。`max_output_tokens` 映射 `max_tokens`；`thinking` 映射 `thinking.type`；`reasoning_effort` 原样传递。推理模式显式启停，开启时拒绝 temperature；通用适配器拒绝 DeepSeek 推理参数。默认 enabled/high/65536 是开发预设，未证明实验最优。

65536 等于 DeepSeek 在 thinking 模式下不设 `max_tokens` 时的服务端默认值（服务端上限 384K，非 thinking 默认 8K）；文档没有说明推理 token 是否单独计算，按与输出共用上限处理。此前的 4096 很可能放不下推理加一次工具参数，已在 `add-analysis-benchmarks` 中调整。2026-10-12 之前的 EDA 冒烟与 InfiAgent 三题冒烟使用 4096 运行，其配置快照保留原值，不重跑，也不与新值的结果直接比较。没有直接设到 384K，是为了限制单次失控生成对任务预算的消耗。

**视觉能力**：`capabilities.vision` 可选，省略即为 false，旧配置无需修改。只有声明视觉能力的 profile 才能发送图像片段；图像只能放在用户消息中，按文件内容识别 PNG/JPEG/GIF/WebP 并读取像素尺寸，在发送前校验：单张 ≤ 8 MiB、每次请求 ≤ 40 张、单边 ≤ 8192 px，请求含 15 张及以上图片时单边 ≤ 4096 px（均低于 DeepSeek 文档的服务端上限）。图像以 base64 data URL 编码为 chat-completions 的 `image_url` 片段；不接受 http(s) 地址，避免让模型服务代为下载任意外部资源。目前只实现这一种多模态格式，其他协议需要时再增加。

评分使用的评委 profile 示例（`configs/models.json` 中的 `deepseek-flash-judge`）：

```json
{
  "id": "deepseek-flash-judge",
  "provider": "deepseek",
  "protocol": "chat-completions",
  "base_url": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "display_name": "DeepSeek-V4.1-Flash (judge)",
  "api_key_env": "DEEPSEEK_API_KEY",
  "capabilities": { "tool_calls": true, "thinking": true, "vision": true },
  "generation": { "thinking": "disabled", "temperature": 0, "max_output_tokens": 16384 }
}
```

评委关闭 thinking、使用 temperature 0，与上游评委设置对齐；输出上限 16384 与上游示例评委配置一致。评委调用不带工具定义（请求中没有 `tools`/`tool_choice`），返回工具调用、被截断或内容为空都视为失败并保留已知用量。历史保留 DeepSeek `reasoning_content`，不进入最终报告。

凭据仅由宿主从 `api_key_env` 读取，不写入配置快照、提示词或容器；不提供自由 headers/body 注入。仅接受 HTTPS，无 URL 用户名密码/query/fragment；测试及本地服务可显式 `allow_loopback_http: true` 使用回环 HTTP。禁止自动重定向，不向跳转目标转发授权。输入清单只读挂载为 `/input/<相对路径>`，禁止越界和符号链接；任务输入不会授予新工具权限。

默认预算：模型尝试 12 次（含限流重试）、实际单元 8 次、累计 token 停止阈值 100000、请求 90000 ms、任务 300000 ms、限流重试 2 次、连续代码错误后修复 2 次、全任务动作纠正 2 次、请求 256 KiB、响应 2 MiB、模型轨迹累计 16 MiB。单次输出上限由模型 profile 控制，示例 65536 tokens；其他预算字段见 `DEFAULT_BUDGET`。

每次派发前，智能体检查“已用 token + 本次输入估算 + profile 输出上限”是否超过累计阈值，超过即以 `token_preflight` 停止。因此输出上限越大，同一阈值下可用的轮次越少：65536 配 100000 阈值时，累计用量超过约 3.5 万就会停止。需要多轮分析的任务应按“预期用量 + 65536”设置阈值。单次响应接收上限 2 MiB 足以容纳 64K token 的回复；模型轨迹累计 16 MiB 不变，接近时如实报告。

## 调用和失败语义

每次 HTTP 尝试单独记账，取消/超时/断流/不明确 5xx 的生成结果和成本标 unknown，不自动重试。仅 429 作为服务拒绝生成的限流响应，在次数与剩余时间内退避重试；401/403/参数/协议错误直接失败。单请求大小和超时为硬限，响应分块计数后才解析，超限片段不能执行。工具 ID、响应角色、结束原因与消息结构必须有效；缺失或重复 ID 不能构造下一轮合法历史，直接停止。

用量保留原始 usage 与归一化字段，实际总量为 prompt_tokens + completion_tokens。缓存命中/未命中是输入子项，推理 token 是输出子项，不重复相加。缺失字段保留 null/unknown；货币成本未计算，不能记为免费。请求体 UTF-8 字节数作为输入估计并与单次输出额度作事前检查，估计不冒充实际 tokenizer 计数，也不是数学上界。真实总量达到阈值后停止，允许记录最后一次调用造成的超出；未知消费停止为 failed/accounting_incomplete。

## 记录版本

新运行写 schema_version=2，`run_kind` 为 runtime/agent/code_replay。`config` 保留 SessionConfig，便于原代码重放；模型 profile、实际返回身份、提示词版本/哈希、token ledger 和智能体目标/预算分别存放。runtime/code_replay 的 model/prompt/tokens/agent 为 `not_applicable`。版本 1 可读取，导出生成新 Notebook 和独立 export-UUID.json，不覆盖旧 manifest/events；不做原地迁移。

模型轨迹用 `model_request/model_response/model_failure/tool_validation/agent_budget/agent_finish` 事件，内容保存为有界、带哈希的宿主产物，事件只存引用。模型事件不计为 Python 单元终态。单次请求本地 attempt_id、服务 response_id 与工具/执行/单元身份分别保存；请求意图落盘成功后才允许发起 HTTP。未收到终结事件的意图保持未知，不推断免费或成功。模型轨迹累计配额与执行产物配额分开；写入失败后记录器拒绝继续操作。

脱敏状态示例：成功 ledger 为 `{status:"known", input_tokens:12, output_tokens:4, total_tokens:16, attempts:1, unknown_attempts:0, currency_cost:"not_computed"}`；缺失 usage 或中断保留已有已知小计并设置 `status:"unknown", unknown_attempts:1`，不能把小计当成总消耗。无模型运行整个 tokens 字段是 `not_applicable`。

## 循环、反馈与完成

工具 schema 与宿主校验一起维护：`execute_python({code})` 串行执行一个单元；`finish_analysis({summary,findings,methods,limitations})` 提交结构化结论。每条 finding 至少有 statement 和 evidence_refs，可附 JSON value；methods 非空，limitations 可为空。完成必须引用本次已成功执行单元或保存完整产物。虚构、跨任务或未成功单元引用均拒绝，引用存在性不等于语义正确性。

一轮只能有一个动作，多个调用（包括执行与完成混合）全部拒绝，为可辨认 ID 逐一回传拒绝；重复 ID 直接失败。普通 Markdown 不提取代码。普通错误后的修复使用新单元，成功重置连续代码错误计数；动作纠正计数全任务不重置。内核丢失、保存不完整、超时、未知结果不重启不重试。完整历史（包括必需推理协议字段）保留至请求/轨迹大小上限，不自动摘要或删去失败单元。

反馈包含单元身份、状态、内核可用性、部分修改提示、有界文本预览、截断标记和产物引用；图表注明未视觉观察。模型没有读取宿主产物或 shell 的工具。实际执行 started=true 才累计代码次数；达到代码次数后仍允许调用模型完成，但拒绝新的执行。模型尝试数、时间与单请求字节为硬限制，累计 token 为结算后的停止阈值。

完成产物为 analysis.json 和确定性生成的 analysis.md，记录 Notebook 路径与导出状态。completed 仅在完成提交、关闭、导出和记录成功后返回；预算耗尽、超时、取消、失败不会再调用模型补写总结。错误修复后的 Notebook 保留错误单元，分析可完成但严格代码重放仍为 unsupported。重放只执行已保存代码，不复现模型决策，也不复制源运行的模型成本。

## 报告输出

任务配置可以带 `report`（`image_types`、`max_images`、`max_image_bytes`、`max_report_bytes`），要求以 Markdown 报告结束，例如 `configs/tasks/synthetic-report.json`。系统提示词不变；报告要求以约束和工具说明传达，元数据中提示词版本记为 `eda-single-v1+report-v1`，提示词哈希与文本任务相同。文本任务的工具 schema 和提示词版本（`eda-single-v1`）保持原样。

模型用 `execute_python` 在工作目录写 `.md` 报告，并把图表保存为同目录（或子目录）下的 PNG/JPEG 文件；这些文件按工作区快照保存为产物。完成时 `finish_analysis` 必须额外给出 `report_artifact_id`，即报告文件对应的 artifact_id。宿主校验：

- 该 ID 是本次运行保存的完整产物，路径以 `.md` 结尾，UTF-8，大小不超过 `max_report_bytes`；
- 报告中的图片引用（`![说明](路径)`，与 DAComp 上游评委相同的匹配规则）必须是相对报告所在目录的相对路径，可以带 `./`，不能带 URL scheme、绝对路径或 `..`；
- 每个引用解析到本次运行在该工作区路径上最新保存的产物，按内容识别为允许的图片类型，大小不超过 `max_image_bytes`，去重后数量不超过 `max_images`。

任一项不满足即拒绝完成动作并计入动作纠正预算，模型可以改写报告后再次提交。通过后 `analysis.json` 增加：

```json
{
  "report": {
    "artifact_id": "<报告产物 ID>",
    "source_path": "report.md",
    "images": [
      { "reference": "chart.png", "path": "chart.png", "artifact_id": "<图片产物 ID>" }
    ]
  }
}
```

`reference` 是去掉 `./` 后的报告内写法，`path` 是工作区路径。模型看不到图片，只能依据计算结果描述图表；这一局限保留。评测适配器只把报告和被引用的图片复制进交付目录，引用无需改写即可在交付目录中解析，未被引用的图片不交付。

**统一轨迹（trajectory-v1）**：评测启用 DAComp 上游兼容模式时，适配器根据原生事件生成 `trajectory.txt`：按执行顺序列出每个单元的代码、状态和有界输出预览（截断时标注），最后附上最终报告（文本任务附 summary）。整体上限 256 KiB，超出时保留首尾、从中间截断并写明省略字节数。宿主路径和模型密钥会被替换为 `[host]`；轨迹不含评分材料。多角色实现以后需要按适配器版本另行定义映射。

## 本地使用

先按 README 构建 `statigent-runtime:dev`，在宿主环境设置 `DEEPSEEK_API_KEY`。密钥不写入仓库，不需要传给 Docker。相对输入根按命令工作目录解析。

```sh
bun run agent run --task configs/tasks/synthetic-eda.json --models configs/models.json --model deepseek-flash
bun run runtime inspect runs/agent/<run_id>
bun run runtime export runs/agent/<run_id>
bun run runtime replay runs/agent/<run_id> runs/replays
bun run runtime cleanup <run_id>
# 显式付费验收：只运行一个合成任务，不自动重跑。
bun run test:smoke:model -- --model deepseek-flash --task configs/tasks/synthetic-eda.json
```

运行前打印生效预算和生成参数，结束打印 run_id、目录、终态与原因，非 completed 退出码为 1。Ctrl-C 取消等待/活动执行并进入清理。冒烟还验证至少两个成功单元、分组均值、PNG 解码、结论引用、Notebook、实际 token 和无残留容器，将结果写为 smoke-result.json；检查失败同样退出 1。期望均值只保存在宿主验收器，不向模型提供答案或预写代码。

默认 `bun run check` 与 `bun run test:integration` 只用可控模型，后者使用真实 Docker；即使已设置 API key 也不调用付费服务。自定义 profile 的支持范围以协议测试为准，应另行显式冒烟。运行目录不提交 Git。

任务总时限以 `budget.task_timeout_ms` 为准，会覆盖并派生执行会话的 task_timeout_ms；会话启动时限也不能超过剩余任务时间。运行耗时从预检前开始计，清理有执行层独立宽限，墙钟包含清理，不能简单相加可能重叠的阶段字段。`runtime inspect` 附加 model_journal，显示缺失响应/失败终结的请求 ID 和截断尾部，不改写源文件，不据此猜测服务成本。

本次实际检查、真实 DeepSeek 用量、运行 ID 和代码重放结果见 [本地验收记录](eda-agent-validation.md)。
