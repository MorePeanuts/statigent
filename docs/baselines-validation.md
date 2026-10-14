# 研究 baseline 开发验收

变更 `add-research-baselines`，实现进行中；本文只记录实际运行结果，不表示四种方法已接入评测。

2026-10-15，macOS arm64，Bun 1.4.2、uv 管理的 CPython 3.12.9：

| 层次 | 实际状态 |
| --- | --- |
| 方法来源/严格配置/默认矩阵 | 3 个单元测试通过，29 个断言；TypeScript 检查通过 |
| AutoGen 0.2.35 无模型导入 | 通过；实际角色、ModelClient 和 CodeExecutor 接口可用 |
| DatawiseAgent 固定源码导入 | 通过；66 文件身份校验、实际 FST/模型/执行器阶段接口可用 |
| AutoGluon CPU fit/save/load/predict | Linux arm64 Docker 通过；六类模型、两层模型及 weighted ensemble 实际训练，重新加载预测一致 |
| DatawiseAgent FST 受控响应 | 未运行，待明确过滤阶段重放边界 |
| 两个计算镜像资源探针 | 通过；UID 10001、2 CPU、4 GiB、断网、只读根目录及 8 MiB 独立写入额度实际验证 |
| JSONL 协议与运行记录 | 4 个 TS 协议测试、1 个记录测试、7 个 Python 协议测试通过 |
| 受信 worker/宿主模型基础层 | 2 个 worker 测试、5 个父账测试通过；供应商历史保留，未知消费停止重试 |
| 官方 AutoGen 受控响应 | 通过；实际 AssistantAgent/UserProxyAgent 完成错误反馈、代码修复和显式文本交付，3 次调用共 45 个受控 token，未调用付费 API |
| 执行后端隔离 | 持久内核/新脚本两个实际 Docker 测试通过；宿主凭据、仓库、私有材料、其他运行及网络不可见 |
| worker 与容器生命周期 | 实际 Docker 测试通过；异常退出/取消/超时均清理所属容器，另一内核的变量状态保留；评测批次停止派发的接入仍未完成 |
| 冻结预测 | 未运行 |
| 评测计划/运行/评分/比较/独立复现 | 未完成 |
| 真实模型开发冒烟 | 未运行，需明确 scope/预算及授权 |
| 正式实验 | 未运行 |

DatawiseAgent 首次导入缺 `websockets`，补齐其原始版本后暴露上游模块导入即创建 OpenAI 客户端的问题；通过独立导入边界禁用直连 SDK/dotenv 后复验通过。未使用 API 密钥，未产生模型消费。这些是环境修复记录，不是正式任务失败重跑。

AutoGluon macOS 首次缺 libomp；安装 23.1.3 后六家族混合训练卡在 PyTorch `sqrt` 的 OpenMP barrier，采样可见不同 libomp 地址。已定向终止，macOS 原生训练仍未通过；不把修复依赖导入记为训练通过。部署/验收使用 Linux arm64 Docker，全部模型家族保持不变，实际 fit/save/load/predict 约 5.95 秒，含容器启动与清理约 12.90 秒，父进程设置 240 秒硬截止。共同镜像探针约 4.95 秒。探针使用合成数据和缩小参数，不能代表正式任务耗时。

首次通过的镜像身份见 [images.json](../environments/baselines/images.json)。原始构建日志、失败诊断和三份 Docker 探针结果位于忽略 Git 的 `runs/baseline-environment-validation/`；未提交模型、数据或完整运行轨迹。后续镜像包含源码更新时必须重新构建并登记新摘要，不能把旧摘要称为新环境。

安装命令、来源和依赖差异见 [可选环境说明](../environments/baselines/README.md)。上游导入通过不代表边界桥接、完整阶段转换或研究效果已经验收。

## 待明确的方法边界

固定上游 `datawiseagent/agents/datawise_agent.py` 的 `_self_debug_filter` 调用 `_execute_cells(..., rerun_all=True)`；后者调用 `Session.rerun_cells()`，主动重启内核并重放过滤前保留的历史，再验证筛选代码。这属于核心过滤阶段，不是故障后的自动恢复。

当前提案写有“自动内核恢复/重放禁用”，配置也使用 `kernel_replay=false`，与保留官方过滤机制存在冲突。建议修订为：保留过滤阶段明确发起的已知历史重放；仍禁止执行结果未知或状态丢失后的自动恢复。实现需增加限定原因的宿主重启请求、记录新 kernel epoch、将重放执行计入同一预算，并在冻结后拒绝重启/重放。不得通过跳过过滤、吞掉重放错误或替换 FST 来使探针通过。

该决定待确认；DatawiseAgent worker 当前明确返回不可用。其余已完成基础层已保留，四方法注册、冻结预测、比较配置等仍未完成。
