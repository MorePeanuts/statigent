# 执行会话协议

宿主通过 `DockerSession.create(config, observer?)` 创建任务容器；`execute(code, { requestId? })` 返回有界结果，`cancel(requestId)`、`restart()`、`close()` 走独立控制路径。所有接口与数据定义见 `src/execution/protocol.ts`，传输实现见 `src/execution/docker.ts`。默认检查使用可控 transport，不启动 Docker。

## 配置与边界

`SessionConfig` 包含 `run_id`、可选 `session_id`、`image`、可选 `platform`、`input_root`、`inputs`（根内的相对普通文件路径）、`staging_root`、`seed` 与完整 `limits`。宿主复制显式输入到独立目录，再只读挂载；不挂载输入根、仓库或记录区。非法路径、路径中任一级符号链接及非普通文件在容器启动前被拒绝。

默认使用 1 CPU、1 GiB 内存（禁用额外 swap）、128 个进程、64 MiB 工作空间和 32 MiB 临时空间。启动及单元时限各 30 秒，任务总时限 5 分钟，中断宽限 3 秒，等待队列最多 16 项。代码上限 128 KiB，协议帧上限 1 MiB，会话累计输出上限 8 MiB，单个产物上限 512 KiB，累计产物上限 16 MiB，单元工具预览 4,000 字符。这些是合成验收默认值，实际生效配置保存在清单中；较大任务需要显式配置。

执行容器使用非 root 用户、只读根文件系统、私有 tmpfs、禁网、移除 capabilities 和 no-new-privileges。环境只注入运行必须的目录、种子和线程数，并清空 Docker 代理变量。容器不获得 Docker socket、宿主密钥或宿主记录目录。控制层拒绝 Docker Engine 无法应用必需资源限制的环境，不退回宿主运行 Python。

## JSONL 消息

stdout 每行一个 UTF-8 JSON 对象，没有 TTY；stderr 仅用于桥接诊断。双方校验 `protocol_version: 1`、`request_id` 和 `session_id`；执行相关输出必须匹配 `cell_id`、`kernel_epoch`、`execution_seq`。宿主逐帧等待处理及持久化，避免输出洪泛排满无界内存队列。

初始化请求使用 `type: init`，附带 `kernel_epoch: 1`、`seed` 和完整 `limits` 对象；`DEFAULT_LIMITS` 提供所有必需字段。合法执行请求：

```json
{"protocol_version":1,"request_id":"request-1","session_id":"session-1","type":"execute","cell_id":"cell-1","kernel_epoch":1,"execution_seq":1,"code":"x = 41\nprint(x + 1)"}
```

桥接返回 `ready`、`output`、`artifact`、`result`、`control` 或 `diagnostic`。输出保留 Jupyter 的 `stream`、`execute_result`、`display_data`、`update_display_data`、`clear_output`、`error` 语义，支持文本、HTML 和 PNG。`result` 是确认完成后的终态，不以第一条输出或 shell reply 提前完成。

```json
{"protocol_version":1,"request_id":"request-1","session_id":"session-1","type":"result","cell_id":"cell-1","kernel_epoch":1,"execution_seq":1,"status":"ok","kernel_available":true,"elapsed_ms":12.5,"persistence_complete":true}
```

缺少身份、使用版本 2、代码不是字符串、超过帧上限、返回其他会话或单元身份，都会触发明确的协议错误。宿主不会将无效响应解释为成功，也不会自动再次派发结果未知的代码。重复请求 ID 和队列已满会在宿主拒绝。

## 结果与中断

`ExecutionResult` 区分 `ok`、`error`、`timed_out`、`cancelled`、`kernel_lost`、`output_limit_exceeded`、`protocol_error`。结果提供 `started`、实际序号（仅已开始）、等待与执行耗时、内核可用性、预览、产物引用和完整度。排队取消不获得执行序号，也不计执行时间。派发前的记录写入仍在等待时发生取消，代码不执行；事件日志保留派发意图，但最终结果以 `started=false` 和缺省序号标明。普通 Python 错误不回滚，`partial_state_possible` 提示前面的修改可能已生效。

单元超时和活动取消先发送 `interrupt`，宿主宽限计时不依赖桥接进程；确认终态和可用内核后才能派发后续代码。不能确认时强制终止容器并取消队列。任务总超时停止接收新请求，关闭并报告 `task_timeout`。显式重启取消旧队列，递增 epoch，报告工作文件是否保留。关闭幂等；资源清理失败在关闭结果中可见。关闭先显式收集再关闭桥接；收集完整度与超限通过控制响应报告，未完整收集标为 `incomplete_artifacts`，超限标为 `output_limit_exceeded`，不生成成功收集承诺。

预览截断 `preview_truncated` 不代表保存不完整。超过累计输出或产物限制会返回 `output_limit_exceeded` 与 `persistence_complete=false`；不能宣称保存全部内容。传输长 stream 时桥接拆为有界帧，单个无法放进一帧的富输出属于保存限额，不支持无限大富对象。

## 记录接入

`SessionObserver.onEvent` 必须返回 Promise，宿主在派发前和返回终态前等待持久化；写入失败立即禁止新工作并终止会话。事件都有 `type`、`at`、`run_id`、`session_id`：

| 事件 | 内容 |
| --- | --- |
| `session_start` | 完整有效配置 |
| `ready` | 镜像 ID/digest、Docker 版本、容器平台、输入哈希、依赖信息 |
| `dispatch` | 派发前持久化的请求意图、代码、单元和 epoch、计划序号、等待耗时 |
| `finish.started` | 最终确认是否实际派发；持久化期间取消则为 false，没有实际执行序号 |
| `output` | 原始输出消息，包含正确的请求身份 |
| `artifact` | 容器消息与宿主生成的产物引用 |
| `finish` | 完整 `ExecutionResult` |
| `interrupt` | 请求身份和中断原因 |
| `restart` | 新 epoch 与文件保留状态 |
| `diagnostic` / `failure` | 无法归属、协议或执行环境诊断 |
| `close` | 运行终态、清理耗时、总墙钟耗时及清理错误 |

`onArtifact` 保存文件并返回宿主生成的 ID、路径、SHA-256、字节数、MIME 及完整度。长文本、HTML 和 PNG 输出也经过此接口。未配置产物接收器时不会生成虚假的持久引用；正式运行 CLI 使用宿主记录器。容器原路径只作为任务内相对名称，绝不能直接用于宿主任意读写。

## 独立脚本协议 v2

`SessionConfig.backend` 只接受 `persistent-kernel`（缺省）与 `fresh-script`。可信工厂 `createSession` 选择固定容器入口；模型仍只提交 `execute_python({code})`，不能指定命令。旧内核入口及 wire v1 不变。脚本要求镜像标签 `org.statigent.fresh-script=2`，不匹配在模型请求之前失败。

脚本 JSONL 使用 `protocol_version=2, backend="fresh-script"`，共同身份为 `request_id/session_id`；执行、输出、结果再携带 `execution_id/execution_seq`，没有 `cell_id/kernel_epoch/kernel_available`。`init(seed,limits)` 返回 `ready(initialization="script-init-v1",dependencies,session_available)`；`execute(code,execution_id,execution_seq)` 每次启动独立进程。控制消息只有 `interrupt(target_request_id,reason)`、`collect`、`shutdown`，没有重启或恢复内存接口。

结果字段语义：

| 字段 | 含义 |
| --- | --- |
| `execution_id` | 宿主分配的尝试身份，未派发也存在 |
| `execution_seq` | 实际派发顺序，排队取消不分配 |
| `started` | 已确认完成初始化并进入脚本；通道丢失不能据此推断没有文件副作用 |
| `process` | `{instance_id,pid}`，未创建或无法确认时为 null；PID 仅在容器内有意义 |
| `session_available` | 已确认后代清理完成、允许下一轮；进程正常退出不等于会话丢失 |
| `memory_preserved/files_policy` | 恒为 `false/task-workspace`；历史提示仍保留，文件允许显式读写 |
| `persistence_complete` | 本轮输出与文件是否完整保存，未知或超限为 false |
| `partial_state_possible` | 已派发的失败尝试可能留下部分文件，不承诺回滚 |
| `timing` | `process_startup_ms/execution_ms/collection_ms/cleanup_ms`；未观察到的阶段为 null，不伪造为 0 |
| `elapsed_ms/waiting_ms` | 整个尝试与派发前等待；阶段时间已经包含在尝试耗时中，不再次相加 |

终态为 `ok/error/timed_out/cancelled/session_lost/output_limit_exceeded/protocol_error`。成功要求已开始、有进程身份、会话可用且保存完整。未开始取消返回 `started=false,process=null`；已派发但结果未知保留身份和已存产物，禁止自动重试。身份错位、未知版本、错误字段类型及迟到输出导致会话失败并清理容器。
