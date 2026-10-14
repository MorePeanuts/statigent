# Docker Notebook 执行环境

旧双角色 EDA 使用原生运行清单 v3，新写入使用 v4：`collaboration.roles` 分别记录 planner/executor 的模型、提示词和用量，顶层用量为全任务合计；`collaboration.subtasks` 关联委派和执行者用量。角色小计、子任务小计是同一消费的不同视图，不再次相加。旧 v1/v2 记录仍可检查、导出和按原资格重放，不原地迁移。

双角色完整日志保存原始代码与调试历史，规划者仅接收子任务结果。规划者报告由宿主保存，具有模型提交来源，不伪造 Python 单元。Notebook 仅包含实际执行代码；代码重放不调用任何角色模型，也不重新生成规划者报告或验证报告结论。原始错误、截断或状态丢失的轨迹仍按既有规则报告严格重放不支持。

本阶段验证持久 Python 内核、受控代码执行和记录链路，不调用模型、不启动正式 Benchmark，也不表示两章研究方法已完成实验验证。研究依据见 [overview.md](overview.md)，首个变更见 [add-docker-notebook-runtime](../openspec/changes/archive/2026-10-12-add-docker-notebook-runtime/proposal.md)。

## 本地前提与工程入口

控制程序使用 Bun（版本见 `package.json`），Python 版本见 `.python-version`，依赖由 `bun.lock` 和 `uv.lock` 固定。TypeScript 使用 strict ESM、Biome 和 tsc；Python 使用 Ruff 和 pytest。TypeScript 运行时依赖 Zod 校验建模基准目录与数据准备配置，Commander 解析 `evaluate audit`、`prepare` 和 `audit-prepare` 参数；其余入口暂沿用现有解析器。Jupyter Client 管理真实内核，ipykernel 执行代码，nbformat 独立校验 Notebook，NumPy/pandas/Matplotlib 用于合成分析验收。无需 Jupyter Server。

macOS 本地需要可用的 Docker Engine Linux 容器环境。启动前检查 Docker 能否应用内存、swap、CPU 和进程数限制；缺少 Docker、镜像或限制支持会明确失败，不退回宿主直接执行。使用本机原生架构构建，Apple Silicon 通常是 `linux/arm64`，服务器可能是 `linux/amd64`；不把模拟运行耗时当作正式实验性能。

在仓库根目录执行：

```bash
bun install --frozen-lockfile
uv sync --frozen
bun run format
bun run lint
bun run typecheck
bun run test
bun run check
```

`format` 写入格式调整；其余入口非写入式。`check` 汇总 lint、类型检查和快速测试，快速测试只使用合成数据和可控执行器，不启动 Docker、不调用模型、不下载基准。Python 的校验和测试均通过 uv 启动。首次安装依赖可能需要联网；执行镜像运行阶段不安装依赖。

```bash
docker build -f docker/Dockerfile -t statigent-runtime:dev .
bun run runtime demo runs statigent-runtime:dev
bun run test:integration
```

构建上下文通过 `.dockerignore` 限定为运行时和依赖文件。镜像固定 Python、uv 版本并锁定依赖；运行使用镜像 ID，记录 tag 实际解析出的 ID、digest 和平台。`demo` 输出 JSON，其中 `directory` 是宿主运行目录、`run_id` 用于定向清理。示例加载四行 CSV，复用前一单元的 DataFrame，断言 A 组均值为 2、B 组均值为 4，并生成 `means.png`。内核和容器关闭后，宿主产物仍保留。

## 会话、输入与限额

每个任务一个容器、一个真实内核和一个私有 `/workspace`。可信调用方通过 `SessionConfig.input_root` 与相对 `inputs` 清单选择文件，程序拒绝路径穿越、符号链接和非普通文件，再复制到独立暂存区并只读挂载到 `/input`。默认示例只挂载 `tests/fixtures/synthetic.csv`。不要将仓库、基准根或含答案的材料选为输入；当前接口校验文件访问边界，后续基准适配器负责决定内容是否允许使用。

容器以 UID/GID 10001 运行，网络关闭、根文件系统只读、移除 capabilities，启用 no-new-privileges，使用 Docker 默认 seccomp。容器不获得宿主环境变量、凭据、记录目录、Docker socket 或其他任务文件。`/workspace` 和 `/tmp` 使用限额 tmpfs，其占用也计入内存限制。桥接程序与用户代码同属容器，不应把两者看成额外安全隔离边界。

`SessionConfig` 配置输入根、暂存根、镜像、平台、种子和完整 `limits`。初始默认值如下，真实生效配置保存到每次运行清单：

| 配置 | 默认值 |
| --- | --- |
| CPU / 内存 / 进程数 | 1 CPU / 1 GiB / 128 |
| workspace / tmp | 64 MiB / 32 MiB |
| 启动 / 单元 / 任务总时限 | 30 秒 / 30 秒 / 300 秒 |
| 中断宽限 / 队列容量 | 3 秒 / 16 个等待请求 |
| 代码 / 单条协议消息 | 128 KiB / 1 MiB |
| 会话累计输出保存 / 单文件 / 会话累计文件 | 8 MiB / 512 KiB / 16 MiB |
| 工具反馈预览 | 4,000 字符 |

所有上限必须为有效正数；预览截断与保存内容不完整分别报告。超过保存上限会停止执行并返回 `output_limit_exceeded`，不会无限积累输出或假称完整。静态文本、HTML 表格和 PNG 作为数据保存；不执行返回的 HTML，不支持 widgets 或交互 stdin。

## 协议与状态

工具层通过 `DockerSession.create(config, observer)` 创建会话，调用 `execute(code)` 顺序执行。宿主生成请求/单元身份和实际执行序号，在发往容器前持久化代码记录；返回结果运行时校验身份、类型、大小和终态。代码修复使用新请求，不能复用 request ID。控制层不会自动重试未知结果的代码。

协议消息为 stdout JSONL，诊断走 stderr。合法执行请求示意：

```json
{"protocol_version":1,"type":"execute","request_id":"request-1","session_id":"session-1","cell_id":"cell-1","kernel_epoch":1,"execution_seq":1,"code":"x = 2\nprint(x)"}
```

结果包含 `started`、`execution_seq`（仅实际派发时存在）、`status`、`elapsed_ms`、`waiting_ms`、`kernel_available`、`persistence_complete`、`preview_truncated`、`artifacts` 和诊断。普通错误示意为 `status="error"`、`error.ename="ValueError"`；如果代码先修改变量再报错，修改仍可能存在，程序不回滚。`{"code":42}`、不支持的协议版本或身份不匹配均被拒绝，不会被当作成功。

会话状态依次涉及 starting、ready、busy、interrupting、restarting、failed、closing、closed。同会话执行串行化，取消与关闭使用独立控制路径。排队取消返回 `started=false`，不计执行次数；活动取消或超时先请求中断，宽限内确认停止才能继续，不能确认时强制终止容器。终态区分 ok、error、timed_out、cancelled、kernel_lost、output_limit_exceeded 和 protocol_error。

```bash
bun run runtime demo runs statigent-runtime:dev timeout
bun run runtime demo runs statigent-runtime:dev restart
```

超时示例先修改状态再等待，预期返回 timed_out。重启示例先完成统计与绘图，再显式重启，访问旧变量 `df` 预期 NameError。重启分配新 kernel epoch；仍存活的容器内工作文件可保留，内存变量不保留，容器丢失时不能假称文件仍在。首版不支持跨单元后台作业。

## 记录、导出与重放

每次运行在 `runs/<run_id>/` 保存：

- `manifest.json`：非敏感有效配置、输入 SHA-256、镜像与平台、宿主和 Docker 环境、代码 commit/dirty、依赖版本、种子、终态与阶段耗时。无模型 runtime/code_replay 的模型、提示词、token 和划分标为 not_applicable。新记录清单版本为 4，版本 1–3 保留只读及非覆盖式导出；智能体字段及迁移说明见 [agent.md](agent.md)。
- `events.jsonl`：追加式派发、输出引用、异常、取消、重启及终态；错误后修复不覆盖原尝试，未确认完成的单元保持 unknown。
- `artifacts/`：宿主生成随机 ID 的独立快照，索引保存来源、类型、大小、SHA-256 和完整度；原文件覆盖后再收集也形成新快照。
- `notebooks/`：按 kernel epoch 分别导出的 Notebook；清屏和显示更新在导出视图应用，原始事件仍保留。

运行记录持久化失败会使执行停止，不能继续返回无记录的成功。清单的 `workspace_collection` 单独报告工作目录收集情况：正常关闭并确认收集完成时为 complete，强制终止或收集失败时为 incomplete_or_unknown。已经接收的文件可以保留，容器被强制终止前尚未收集的文件只能标为未保存或未知。代码运行中主动打印秘密也会成为任务输出，因此不要把真实秘密放入任务输入或代码。

将下面的 `runs/<run_id>` 替换为 demo JSON 中的 `directory`：

```bash
bun run runtime inspect runs/<run_id>
bun run runtime export runs/<run_id>
bun run runtime replay runs/<run_id> runs
```

导出调用 nbformat 校验；多次导出生成不同文件，不覆盖较早导出的 Notebook；旧记录使用独立同级导出目录。导出状态、重放资格和重放结果是三个独立字段。错误、保存截断、未知/中断或多个 epoch 的轨迹仍可以导出，但首版不支持重放验证。仅预览截断、实际保存完整时仍可重放。

重放核对原输入校验值、原镜像 ID 和平台，重新暂存允许的输入，在全新容器和空工作空间中执行；不挂载原运行记录或中间文件。原输入文件需要仍存在且校验值一致。镜像/输入不符会留下独立失败结果，不宣称同条件通过。新 run ID 的 `replay_of` 指向原运行，耗时独立计算；原 manifest、事件和产物不改写。重放任一单元失败即停止，不删除或自动修复代码。

Notebook 导出只证明文件符合格式；重放通过只证明代码在记录条件下能够再次执行。合成测试的数值断言与 PNG 可解析检查提供本例正确性证据，不代表一般分析正确，也不要求图像字节完全相同。启动、实际执行、等待、清理分别计时，任务总墙钟独立记录；等待可以与其他请求执行重叠，不应将所有字段相加当作墙钟时间。

## 清理与后续部署

正常关闭幂等，取消队列并清理当前容器，不删除宿主记录。控制程序异常退出后按运行身份清理：

```bash
bun run runtime cleanup <run_id>
```

入口只匹配 `org.statigent.runtime=1` 和指定 `org.statigent.run` 标签，不清理无关容器。清理错误明确返回，需要保留诊断。

后续大量实验再把同一控制程序、Dockerfile 和锁文件部署到 Linux 服务器，按服务器架构重新构建镜像、设置路径与资源，重跑集成及小规模冒烟测试，再验证并发和长时间稳定性。这不属于首个变更验收条件。正式性能比较固定服务器硬件、平台和预算；本地验收记录不会被当成服务器运行结果。

## 新脚本后端

可信调用方使用 `createSession({...config, backend: "fresh-script"}, observer)`。不指定 backend 时仍使用持久内核。脚本后端与 Notebook 共用镜像、输入暂存和 Docker 隔离参数；运行每份完整脚本时固定 `/workspace`，通过 `uv run --offline --no-sync` 新建 Python 进程。每次重置 Python/NumPy 种子及环境，保留任务工作目录。智能体须在每轮重新 import、定义变量，或显式读取前轮保存的文件。失败可能留下部分文件，程序不回滚。

普通脚本末尾表达式没有 Notebook 自动展示语义：文本使用 `print()`，表格使用 `IPython.display.display(df)`，图片使用 `savefig()` 保存 PNG/JPEG，或显式 `display(Image(...))` 输出 PNG。标准输出与协议管道分离，打印 JSON 不会变成控制指令；交互输入收到 EOF。输出和产物额度在任务内累计，新进程不重置额度。

容器 supervisor 按顺序执行，结束或中断后终止并回收进程组及脱离进程组的后代，再清点 `/proc`。无法确认清理时丢弃整个会话；不支持跨轮后台作业。只有文件能显式延续，Python 变量、导入、环境修改不能延续。初始化、执行、收集和清理均计入任务总墙钟与单次执行超时。脚本 wire v2 字段及未知结果语义见 [runtime-protocol.md](runtime-protocol.md)。

脚本无模型示例（同一锁定依赖镜像）：

```bash
docker build -f docker/Dockerfile -t statigent-runtime:fresh-script .
bun run runtime demo runs statigent-runtime:fresh-script fresh-script
```

示例第一轮保存 `means.csv`，第二轮重新 import 并读取文件，断言 A=2、B=4，再导出 `means.png`。实际镜像身份与验收结果见 [fresh-script-validation.md](fresh-script-validation.md)。

新运行写 manifest v4，`execution` 显式记录后端、协议、初始化、种子重置规则、文件策略及导出类型。`timing.script_stages` 是进程初始化、用户代码、收集、回收的分类小计；无法确认的阶段累计到 `unknown_stages`。这些时间已包含在尝试耗时和任务墙钟中，不能再次相加。

`inspect/export/replay` 命令保持相同入口。脚本导出为 `scripts/<export-id>/<order>-<execution_id>.py` 和有序 `manifest.json`，保留失败源码及结果，`export.notebook_status=not_applicable`。每次导出使用新目录；同名工作文件每次收集为不同宿主快照。重放校验源码哈希、初始化版本、输入和镜像，从空工作目录逐份启动新进程，显式文件依赖必须由前序重放脚本重建，不能从原运行补取。任何错误/未知/截断轨迹返回 unsupported；可重放轨迹中实际重执行失败返回 failed。

旧 v1/v2/v3 按原持久语义只读解释，不补写 execution。旧记录导出写入同级 `<run-directory>-export-<id>`，返回 `export.directory`；源目录及其文件保持不变。代码重放仍创建新的 v4 记录，使用原镜像 ID 和原持久入口，不要求旧镜像声明脚本能力。导出成功、代码重放成功、模型决策复现是不同事实；代码重放不调用模型、不重新生成规划者报告。
