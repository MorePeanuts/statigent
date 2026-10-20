# 本机 Web 工作台

工作台把 EDA 智能体做成一个本机网页：上传数据、填写分析目标、实时观察规划与执行轨迹、取消运行、阅读结论与报告、下载 Notebook。它只调用既有的智能体入口、只读既有的运行记录，不改变智能体行为与记录格式。行为契约见 [openspec/specs/agent-workbench](../openspec/specs/agent-workbench/spec.md)，设计取舍见归档的 [变更记录](../openspec/changes/archive/2026-10-20-agent-workbench/design.md)。

当前只接入 EDA 智能体（单智能体或规划—执行，持久内核或独立脚本后端）；建模智能体留待后续接入。工作台面向本机单用户，不提供登录，不面向局域网或服务器部署。

## 前提

在仓库根目录：

```bash
bun install --frozen-lockfile
docker build -f docker/Dockerfile -t statigent-runtime:dev .
docker build -f docker/Dockerfile -t statigent-runtime:fresh-script .
```

只用持久内核后端时第二个镜像可以不建。Docker 与镜像的其他要求见 [execution-runtime.md](execution-runtime.md)。

模型密钥按 `configs/models.json` 中所选 profile 的 `api_key_env` 提供（默认 profile 为 `DEEPSEEK_API_KEY`），在**启动工作台服务的那个 shell** 中设置；也可以写在仓库根目录的 `.env`（已被 Git 忽略，Bun 启动服务时会读取）。浏览器不接触密钥。提交运行前，服务端会检查密钥是否存在、Docker 是否可达、镜像是否存在且支持所选后端，缺什么就直接说明缺什么，不会先启动再失败。

## 启动

```bash
bun run workbench
```

打开 <http://127.0.0.1:3100>。服务只监听 `127.0.0.1`。换端口：

```bash
WORKBENCH_PORT=3200 bun run workbench
```

`bun run workbench` 是开发模式（修改代码即时生效）。需要更快的页面响应时可先构建再启动：

```bash
bun run workbench:build
bun run workbench:start
```

## 使用流程

1. **输入数据**：在左侧上传 CSV / TSV / XLSX / JSON / Parquet（单文件默认上限 100 MiB），勾选本次要用的文件。同名文件不会被覆盖，需要先删除。删除只影响输入区，不影响已完成的运行。
2. **新建分析**：填写目标与约束，选择模型、组织方式（单智能体 / 规划—执行）、执行后端（持久内核 / 独立脚本）、预算（留空为智能体默认值），可要求提交含图表的 Markdown 报告。表单错误会显示在对应字段旁。
3. **运行详情**：提交后进入运行页。“轨迹”按记录顺序实时显示：规划—执行模式下执行者的工作归入各子任务，每次代码执行合并为一张卡片（代码、输出预览、错误、图表），模型的完整输出和请求内容点击后才加载。右侧显示每次模型调用前记录的剩余预算与累计 token。运行中可以取消；取消后智能体以 `cancelled` 结束并保留已完成的产物。
4. **结果**：结论摘要、每条发现及其证据（点击“执行 N”跳回轨迹中的对应单元）、报告、方法与局限。未完成的运行会明确提示“没有被接受的最终结果”，不会把部分产物当作结论。
5. **文件与成本**：下载 `analysis.json`、`analysis.md`、Notebook 或脚本导出，查看 token、调用与执行次数、耗时和输入文件校验值。
6. **运行历史**：`/runs` 列出工作台发起的全部运行；无法读取的记录单独列出，不影响其他行。

同一时间默认只允许一个运行（Docker 资源与付费调用成本），可用 `WORKBENCH_MAX_RUNS` 调整。

### 运行状态

| 状态 | 含义 |
|---|---|
| 启动中 / 运行中 / 收尾中 | 本服务持有该运行的 worker 进程，记录与进程都在进行 |
| 已完成 / 预算耗尽 / 已超时 / 已取消 / 失败 | 智能体自己写下的终态 |
| 失败（启动阶段） | worker 在智能体创建运行记录前就退出了，详情给出退出码与错误摘要 |
| 已中断 | worker 已退出但记录没有终态，例如崩溃或被强制结束（取消后 30 秒仍未退出；或超出任务时限 60 秒时先发终止信号，再过 30 秒仍未退出） |
| 状态未知 | 本服务不持有该运行的 worker（例如服务重启过），无法确认它的结局；不提供取消 |

## 配置项

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `WORKBENCH_PORT` | `3100` | 监听端口（只用于 `bun run workbench` / `workbench:start`） |
| `WORKBENCH_MAX_RUNS` | `1` | 同时进行的运行上限 |
| `WORKBENCH_MAX_UPLOAD_BYTES` | `104857600` | 单个上传文件的字节上限 |
| `WORKBENCH_IMAGE_PERSISTENT` | `statigent-runtime:dev` | 持久内核后端使用的镜像 |
| `WORKBENCH_IMAGE_FRESH_SCRIPT` | `statigent-runtime:fresh-script` | 独立脚本后端使用的镜像 |
| `WORKBENCH_BUN` | 当前 Bun | 启动 worker 的 Bun 可执行文件 |
| `STATIGENT_ROOT` | 当前目录 | 仓库根目录；服务应在仓库根目录启动 |

## 目录布局

全部位于 `runs/workbench/`（随 `runs/` 一起被 Git 忽略）：

```text
runs/workbench/
  inputs/                     上传的数据（.uploading/ 为上传中的临时文件）
  runs/<run_id>/              智能体运行记录：manifest、events.jsonl、artifacts、notebooks、analysis.*
  supervisor/<run_id>.json    工作台旁路记录：pid、起止时间、退出码、stderr 尾部、取消与强制结束
  supervisor/<run_id>.task.json  交给 worker 的任务快照
  smoke/<run_id>.json         冒烟验收结果
```

旁路记录写在运行目录之外，不改变运行记录的格式与完整性校验范围；worker 在智能体创建记录前失败时，它是唯一的诊断来源。

## 安全边界

- **只在本机访问**：服务绑定 `127.0.0.1`；每个请求的 `Host` 必须是回环地址（防 DNS rebinding），会改变状态的请求必须带与之同源的 `Origin`（防其他网站借浏览器发起付费运行）。用脚本调用 POST/DELETE 接口时需显式带上 `Origin: http://127.0.0.1:<port>`。
- **上传**：只接受单层文件名与白名单扩展名，流式写入并核对 `Content-Length`，原子落盘且不覆盖。上传接口不经过 Next 的 Proxy（Proxy 会把请求体缓冲到 10 MB 并截断），由处理函数自己做同样的访问检查。
- **密钥与环境**：worker 只拿到 `PATH`、`HOME`、`TMPDIR`、`LANG`、Docker 相关变量和所选 profile 的那一个密钥变量，并以 `--no-env-file` 启动，不会再从 `.env` 读入其他变量。生成的代码仍在 Docker 执行环境中运行，隔离强度与命令行使用时相同。
- **读取运行内容**：浏览器只能读取 manifest 中登记过的产物（复核 sha256）以及运行自己记录的结果文件；路径中不允许出现符号链接。图片按文件内容识别类型，HTML、SVG 等一律按纯文本返回，所有响应带 `nosniff` 和 `default-src 'none'` 的 CSP。
- **报告渲染**：不渲染原始 HTML；图片只解析到本次运行为报告登记的产物，其余图片（包括远程地址）被忽略；链接只保留 http(s) 并以 `noreferrer` 打开。
- **评测数据**：工作台只扫描 `runs/workbench/`，不读取 `private/`、`evaluator/`、上游答案或 TabArena 原始数据。

## 遗留 worker 的手动处理

正常关闭服务（Ctrl-C）时，服务会把终止信号转发给所有 worker，它们以 `cancelled` 收尾。若服务进程异常退出，worker 可能继续运行直到自身的任务时限，网页上该运行显示为“状态未知”。需要提前结束时：

```bash
cat runs/workbench/supervisor/<run_id>.json
ps -p <pid> -o command=
kill -TERM <pid>
```

先用第二条命令确认该 pid 确实是 `src/workbench/worker.ts` 且参数中带有这个 run ID，再发送信号；pid 可能已被系统复用，工作台不会自动按 pid 结束进程。

## 冒烟验收（付费）

```bash
bun run test:smoke:workbench -- --model deepseek-flash
```

它在 3199 端口启动服务，经与浏览器相同的 HTTP 接口上传 `tests/fixtures/synthetic.csv`，提交固定的双角色合成报告任务（`configs/tasks/collaboration-report.json` 的目标、约束与预算），订阅事件直到终态，再检查：运行完成、事件按序无缺口、结论被接受且含 A=2、B=4 的分组均值、证据都能解析、报告与其图片可读、Notebook 可下载。结果写入 `runs/workbench/smoke/<run_id>.json`，失败时退出码为 1。每次调用只跑一次，不自动重试；缺少密钥或镜像时在前置检查处停下，不产生模型调用。实际检查与真实冒烟结果见 [workbench-validation.md](workbench-validation.md)。

## 测试

默认检查不需要任何模型密钥：

```bash
bun run check
bun test tests/integration/workbench-supervisor.test.ts tests/integration/workbench-runs-api.test.ts
```

单元测试覆盖访问校验、模型列表脱敏、输入区、任务组装、前置检查、worker 入口、状态判定、事件增量读取与规范化、产物访问和结果摘要；集成测试用可控的替身 worker（`tests/fixtures/workbench/fake-worker.ts`）在子进程中跑真实的智能体循环，验证启动、取消、强制结束、崩溃、并发上限、环境变量白名单、SSE 推送与续传。界面没有自动化 UI 测试，依靠冒烟与人工核对。

## 与研究实验的关系

工作台用于试用、演示与人工复核，**其运行不作为论文的正式实验结果**。正式实验仍通过评测入口按冻结的任务、划分、预算与重复次数运行（见 [evaluation.md](evaluation.md)）；评测入口不读取 `runs/workbench/`。
