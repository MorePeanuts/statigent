# Design

## Context

动机见 proposal.md。与实现方式相关的现状与约束：

- EDA 入口是 `runAgent(options)`（`src/agent/run.ts`）。它接受可选 `runId`，运行目录固定为 `<runRoot>/<runId>`，内含 `manifest.json`、追加式 `events.jsonl`、`artifacts/`、`notebooks/`，完成时写 `analysis.json` / `analysis.md`；报告图片在 `analysis.report.images` 中以 `{reference, path, artifact_id}` 登记。
- 智能体与记录代码依赖 Bun 运行时（`Bun.file`、`Bun.spawn`、`Bun.version`），Next.js 默认跑在 Node 上。
- `src/records/store.ts` 已有 `readManifest`、`readArtifact`（含 `artifacts/<id>` 边界与 sha256 校验）和整文件 `readEvents`；事件中的模型提示/响应以 `content_ref` 存为产物，执行输出可能经 `output_ref` 外置。
- CLI 已把 SIGINT/SIGTERM 接到 `AbortController`，智能体据此以 `cancelled` 收尾并导出 Notebook。
- 执行需要本机 Docker 与 `statigent-runtime:dev`（持久内核）/ `statigent-runtime:fresh-script`（脚本后端）镜像。
- 项目约定：单仓库、Bun 统一依赖、Biome + `tsc --noEmit` + `bun test`、Zod 校验外部输入、不提前拆包。

## Goals / Non-Goals

**Goals:**
- 智能体核心、执行协议与记录格式零改动；工作台只做“组装任务 → 托管进程 → 读记录”。
- 服务端业务逻辑与 Next.js 解耦，可用 `bun test` 在无浏览器、无模型密钥条件下测试。
- 运行生命周期在 Web 服务热重载、浏览器断线时仍可正确呈现。

**Non-Goals:**
- 多用户、鉴权、远程部署、运行排队调度。
- 多轮对话或在已结束运行上继续追问（需新开运行）。
- 建模智能体接入、Benchmark 评测与重放触发、运行间对比。
- 在浏览器中编辑或重新执行 Notebook 单元。

## Decisions

### D1 代码布局：`web/` + `src/workbench/`，单一 package.json

- `web/`：Next.js App Router 应用（`app/` 页面、`app/api/**/route.ts`、`components/`），只做 HTTP/SSE 适配与 UI。
- `src/workbench/`：与框架无关的服务端模块——输入区（`inputs.ts`）、任务组装（`task.ts`）、智能体类型注册（`agents.ts`）、进程托管（`supervisor.ts`）、事件增量读取与规范化（`events.ts`）、运行列表与状态判定（`runs.ts`）、产物访问（`artifacts.ts`）、本机访问校验（`access.ts`），以及 Bun worker 入口 `worker.ts`。
- 依赖加入根 `package.json`，共用一个 `bun.lock`；`web/tsconfig.json` 继承根配置并加入 JSX/Next 插件，`biome.json` 纳入 `web/**`。
- 备选：`apps/workbench` 独立包 + Bun workspaces。当前只有一个应用，拆包会带来第二套 tsconfig/lint/锁定流程，违背“出现实际复用再拆包”的约定，暂不采用。

### D2 运行时：Next 跑在 Bun 运行时，`src/workbench` 只用 `node:` API

- 脚本使用 `bun --bun next dev web -H 127.0.0.1 -p 3100`（生产演示 `next build` + `next start` 同样带 `--bun`），使路由处理器能直接导入 `src/records`、`src/models/config`、`src/agent/config` 等模块。
- `src/workbench/` 自身只用 `node:fs`、`node:child_process` 等跨运行时 API，worker 之外不调用 `Bun.*`，以便万一 Bun 下 Next 出现兼容问题时可退回 Node 运行 Next，仅 worker 用 Bun。实施第一步做最小可行验证（见 tasks 1.x）。
- 路由处理器声明 `runtime = "nodejs"`、`dynamic = "force-dynamic"`，避免被静态化或跑到 Edge。

### D3 进程模型：每次运行一个 Bun worker 子进程

- 新增 `src/workbench/worker.ts`：参数为任务文件路径、模型配置路径、profile ID、运行根目录与预分配的 run ID；内部调用 `runAgent({ runId, ... })`，把 SIGTERM/SIGINT 接到 `AbortController`（与 CLI 相同），结束时把 `AgentResult` 摘要写到 stdout 并以状态码退出。现有 CLI 不接受 `--run-id`，新增 worker 而非修改 CLI，保持研究入口不变。
- 备选 A：路由处理器内直接 `await runAgent`。长任务会被热重载打断、与 Web 进程共享崩溃面，取消也难以与进程生命周期对齐，不采用。备选 B：轮询 `runRoot` 找新目录。无法在启动前拿到 run ID，且 RunRecorder 创建前失败时无从关联，不采用。
- worker 环境变量白名单：`PATH`、`HOME`、`TMPDIR`、`DOCKER_HOST`/`DOCKER_CONTEXT`（若有）及所选 profile 的 `api_key_env`；不继承其余宿主环境。
- 超时由智能体预算中的 `task_timeout_ms` 负责；supervisor 另设“预算时限 + 宽限”的看门狗，只在 worker 失控时强制结束。

### D4 托管状态：内存表 + 运行目录外的旁路记录

- `supervisor` 为单例，挂在 `globalThis` 上，跨 Next 开发热重载保留子进程句柄；记录 `run_id → { pid, started_at, child, exit }`。
- 每次运行另写 `runs/workbench/supervisor/<run_id>.json`（任务快照、pid、启动时间、退出码、stderr 尾部 ≤ 16 KiB、取消请求时间），**不写入**智能体运行目录，避免改变记录格式与完整性校验范围。worker 在 RunRecorder 创建前失败时，旁路记录是唯一诊断来源。
- 显示状态判定（`runs.ts`，纯函数，重点测试）：

  | manifest 终态 | 本服务持有存活子进程 | 显示 |
  |---|---|---|
  | completed / budget_exhausted / timed_out / cancelled / failed | — | 原终态 |
  | running / finalizing 或缺失 | 是 | running / finalizing |
  | running / finalizing | 否，且旁路记录有退出码 | interrupted（附退出码与 stderr 摘要） |
  | running / finalizing 或缺失 | 否，且无退出信息（服务重启遗留） | unknown，不提供取消 |
  | 缺失 | 否，旁路记录有非零退出 | failed（启动失败） |

- 并发上限默认 1（Docker 资源与付费调用成本），可由 `WORKBENCH_MAX_RUNS` 调整。Web 服务收到 SIGINT/SIGTERM 时向全部子进程转发 SIGTERM；硬崩溃导致的孤儿进程只显示为 unknown，在文档中说明手动处理方式（不自动按 pid 杀进程，避免 pid 复用误杀）。
- 取消：发 SIGTERM，宽限 30 s 后 SIGKILL；被 SIGKILL 的运行显示 interrupted，与智能体自己写下的 cancelled 区分。

### D5 事件流：轮询增量读取 + SSE，行号作为事件 ID

- `events.ts` 维护 `{ offset, lineNo }` 游标，从字节偏移读取新增内容，只切出以 `\n` 结尾的完整行，未完成末行留待下次——与 `readEvents` 丢弃截断末行的语义一致。
- 轮询间隔 500 ms（macOS 上 `fs.watch` 对追加写入的通知不稳定，轮询更可预测）；运行到终态且读尽后发送 `end` 事件并关闭流；客户端断开时停止轮询。
- SSE `id` 为事件行号；重连时读取 `Last-Event-ID`（或 `?after=`），跳过已发送行。重放已有行时仍需从文件头按行计数，记录规模（≤ 16 MiB 轨迹上限）下可接受。
- 规范化：用 Zod 判别联合解析已知事件类型（`session_start`、`ready`、`agent_budget`、`model_request`、`model_response`、`tool_validation`、`subtask_delegated`、`subtask_returned`、`dispatch`、`output`、`finish`、`analysis_submitted`、`agent_finish`、`run_finished`、`close` 及脚本后端事件），产出 `{ seq, at, type, role, subtask_id, summary, refs }` 视图；解析失败或未知类型降级为 `generic` 而非中断。
- 大内容不进流：模型提示/响应（`content_ref`）、外置输出（`output_ref`）只推送引用，前端展开时经产物 API 按需拉取。

### D6 产物访问：只按已登记身份读取

- 路由 `GET /api/runs/[id]/artifacts/[artifactId]`：run ID 必须匹配 `^[A-Za-z0-9_-]{1,128}$` 且目录位于 `runs/workbench/runs/` 下（`realpath` 比对、拒绝符号链接）；`artifactId` 必须在 `manifest.artifacts` 中登记，读取复用 `readArtifact` 的边界与 sha256 校验。
- 固定结果文件（`analysis.json`、`analysis.md`、manifest 中 `export` 列出的 Notebook/脚本）走白名单路由，不接受任意相对路径。
- 响应头：`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'`；图片仅允许 PNG/JPEG/GIF/WebP（按内容识别，复用 `src/models/images.ts`），其他类型以 `text/plain` 或附件下载返回。
- 报告渲染用 `react-markdown` + `remark-gfm`，不启用原始 HTML；自定义 `urlTransform` 只把 `analysis.report.images[].reference/path` 映射为产物 API 地址，其余图片地址一律丢弃，链接只保留 `http(s)` 并加 `rel="noreferrer"`。

### D7 本机访问校验

- 服务以 `-H 127.0.0.1` 启动；另在 `web/proxy.ts`（Next 16 将 Middleware 更名为 Proxy，默认 Node 运行时）校验 `Host` 的主机名为 `127.0.0.1`、`localhost` 或 `[::1]`（防 DNS rebinding）；非 GET/HEAD/OPTIONS 请求要求 `Origin` 与 `Host` 同源，缺失 `Origin` 视为不可信（防跨站请求从本机浏览器触发付费运行；本地脚本需显式携带 Origin）。校验逻辑放在 `access.ts` 以便单测。
- Proxy 会把请求体缓冲到内存并在超过上限（默认 10 MB）后截断，大文件上传经过 Proxy 会被静默损坏。因此 matcher 排除恰为 `/api/inputs` 的路径，该路由的处理函数（GET 与 POST）自行调用 `rejectNonLocal`，与 Proxy 使用同一判定；`/api/inputs/[name]` 等其余路径仍由 Proxy 覆盖。

### D8 任务组装与智能体类型注册

- 表单载荷用 Zod 定义（`agent_type`、`goal`、`constraints[]`、`inputs[]`、`model_profile`、`organization`、`backend`、`budget` 部分覆盖、`report` 开关），由此推导前后端共享类型。
- `agents.ts` 注册表：`eda → { payloadSchema, buildTask, workerEntry, views }`。`buildTask` 固定 `input_root = runs/workbench/inputs`、按后端选择镜像（默认 `statigent-runtime:dev` / `statigent-runtime:fresh-script`，可由环境变量覆盖）、`seed` 默认 42，然后调用现有 `validateTask` 与 `preflightInputs` 做最终校验；`report: true` 时使用 `configs/tasks/synthetic-report.json` 同等的报告限制。
- 模型列表来自 `configs/models.json` 经 `selectProfile` 校验，对外只返回 `id`、`display_name`、`capabilities`、`key_present`。

### D9 前端结构

- `/`：左侧输入区（上传、列表、删除），中间新任务表单，右侧最近运行。
- `/runs/[id]`：顶部状态条（显示状态、模型、组织、后端、取消按钮）；主区三个标签——“轨迹”（按规划者/子任务分组的时间线，代码单元与输出折叠展示）、“结果”（结论、报告、证据引用）、“文件”（Notebook/脚本、analysis.json 下载）；侧栏实时预算（剩余模型尝试、执行次数、token、时间）与累计 token。
- `/runs`：历史运行表。
- 样式使用 CSS Modules + CSS 变量（含暗色），不引入组件库或 Tailwind，以控制依赖面；状态管理用 React 内置 hooks 与 `EventSource`，不引入全局状态库。

### D10 测试策略

- 单元（`tests/unit/workbench-*.test.ts`）：输入区文件名/大小/冲突校验；任务组装与非法字段；访问校验（Host/Origin）；事件增量读取（未完成末行、断点续读、未知类型降级）；显示状态判定表；产物路由的 run ID/产物 ID 越界与完整性失败。夹具为合成运行目录。
- 集成（`tests/integration/workbench-supervisor.test.ts`，归入 `test:integration`）：supervisor 启动一个可控的替身 worker（按脚本写合成事件、响应 SIGTERM、或模拟崩溃/拒绝退出），验证状态迁移、取消、看门狗与并发上限，不调用模型与 Docker。
- 冒烟（显式 `bun run test:smoke:workbench --model <id>`）：启动服务、上传 `tests/fixtures/synthetic.csv`、提交小预算任务、订阅事件直到终态，并校验结果页数据接口；需要密钥与 Docker，不进 CI。
- UI 不写像素级测试；关键页面由冒烟与人工核对覆盖。

## Risks / Trade-offs

- [Next.js 在 Bun 运行时下的兼容性] → 第一项任务做最小验证；`src/workbench` 只用 `node:` API，必要时退回 Node 运行 Next、仅 worker 用 Bun，路由处理器改为不直接导入含 `Bun.*` 的模块。
- [Next 打包仓库根 `src/` 外部目录] → 通过 `web/next.config.ts` 设置 `outputFileTracingRoot`/`turbopack.root` 为仓库根，并在验证任务中确认可导入。
- [Web 服务硬崩溃留下孤儿 worker，继续消耗预算] → 运行自带 `task_timeout_ms` 上限；孤儿显示为 unknown；文档给出按旁路记录 pid 手动终止的方法。
- [轮询带来的延迟与 I/O] → 500 ms 对人工观察足够；单用户、并发上限 1，开销可忽略。
- [轨迹体积大时重连需从头计数] → 受 16 MiB 轨迹上限约束；必要时再引入行偏移索引。
- [上传数据含敏感信息] → 仅本机、`runs/` 已在 `.gitignore`；不做上传数据外发；删除仅删除输入区文件，不触及已完成运行的输入快照。
- [工作台运行与正式实验混淆] → 工作台运行根独立为 `runs/workbench/`，不被评测入口读取；文档注明工作台运行不作为论文正式结果。

## Migration Plan

纯新增功能，无数据迁移。回滚只需移除 `web/`、`src/workbench/`、相关脚本与依赖；`runs/workbench/` 为本地数据，可保留或手动删除。

## Open Questions

- 端口默认 3100 是否与本机其他服务冲突——可在实施时通过环境变量调整，不影响设计。
