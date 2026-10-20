# Proposal

## Why

EDA 智能体目前只能通过 `bun run agent run --task <json>` 使用：需要手写任务 JSON、把数据放到合适目录，运行中只能看终端日志，结束后再翻 `runs/` 下的 manifest、events.jsonl、artifacts 和 Notebook。这不利于日常试用、演示与答辩，也不利于人工复核规划—执行轨迹。核心智能体、执行后端和运行记录协议已经稳定，适合在其外侧加一层本机 Web 工作台，把“准备数据 → 提出目标 → 观察过程 → 阅读结果”串成一个可用的界面。

## What Changes

- 新增本机单用户 Web 工作台：Next.js（App Router）提供服务端 Route Handlers，React 前端提供工作台界面；只监听回环地址，无登录。
- 数据准备：浏览器上传 CSV 等表格文件到工作台专属输入区，或从该区选择已上传文件；服务端校验文件名、扩展名、大小与路径，不暴露仓库其他目录。
- 任务配置：表单填写分析目标、约束、模型 profile（来自 `configs/models.json`，只展示非敏感字段）、组织方式（single / planner-executor）、执行后端（persistent-kernel / fresh-script）、预算与是否要求 Markdown 报告；服务端复用现有任务校验生成任务。
- 运行管理：服务端以独立 Bun 子进程启动 EDA 运行（预先分配 run ID），支持取消；子进程异常退出时如实标记状态，不把未确认的运行显示为仍在进行。
- 实时轨迹：通过 SSE 增量推送 `events.jsonl` 的规范化视图——角色与子任务、模型请求/响应与 token 用量、工具校验、代码单元及输出、预算剩余与终态。
- 结果查看：完成后展示 `analysis.md` / 报告 Markdown 与引用图表、证据引用、Notebook 或脚本导出、成本与终态原因；可浏览工作台历史运行。
- 产物访问：浏览器只能通过受限只读 API 按 run ID 与已登记产物读取内容，校验 run ID 格式、记录区边界与产物完整性，阻止路径穿越与符号链接。
- 架构上将“智能体类型”作为可扩展维度，第一版只注册 EDA；建模智能体留作后续变更。
- 不修改 EDA 智能体核心、执行协议和运行记录格式。

## Capabilities

### New Capabilities
- `agent-workbench`: 本机 Web 工作台的可观察行为——输入数据管理、任务提交与校验、运行生命周期（启动、实时轨迹、取消、异常退出）、结果与产物的受限只读访问、历史运行浏览，以及本机单用户的访问与密钥边界。

### Modified Capabilities
<!-- 无。工作台以子进程调用现有入口、只读现有运行记录，不改变 eda-agent、execution-records 等既有需求。 -->

## Impact

- 新增代码：`web/`（Next.js 应用：页面、组件、Route Handlers）；`src/workbench/`（与框架无关的服务端逻辑：输入区管理、任务组装、子进程运行器、事件规范化与产物读取），以及 Bun worker 入口。
- 依赖：根 `package.json` 新增 `next`、`react`、`react-dom` 及其类型与 Markdown 渲染依赖，版本锁定并更新 `bun.lock`；新增 `bun run workbench`（开发）等脚本。
- 配置：`tsconfig.json` / `biome.json` 纳入 `web/`；运行与上传数据写入 `runs/workbench/`（已被 `.gitignore` 忽略）。
- 运行前提：本机 Docker 与 `statigent-runtime` 镜像、所选模型 profile 的 API 密钥环境变量；工作台检测并提示，不代为配置。
- 文档：新增工作台使用说明（`docs/workbench.md`），说明启动方式、前提与安全边界。
