# 研究 baseline 开发验收

变更 `add-research-baselines`，实现进行中；本文只记录实际运行结果，不表示四种方法已接入评测。

2026-10-15，macOS arm64，Bun 1.4.2、uv 管理的 CPython 3.12.9：

| 层次 | 实际状态 |
| --- | --- |
| 方法来源/严格配置/默认矩阵 | 3 个单元测试通过，29 个断言；TypeScript 检查通过 |
| AutoGen 0.2.35 无模型导入 | 通过；实际角色、ModelClient 和 CodeExecutor 接口可用 |
| DatawiseAgent 固定源码导入 | 通过；66 文件身份校验、实际 FST/模型/执行器阶段接口可用 |
| AutoGluon CPU fit/save/load/predict | Linux arm64 Docker 通过；六类模型、两层模型及 weighted ensemble 实际训练，重新加载预测一致 |
| DatawiseAgent FST 受控响应 | 通过；固定官方 FST 实际完成规划、执行、修复、过滤、完成；5 次受控模型调用归入父账 |
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

## 已确定的重放边界（2026-10-15）

固定上游 `datawiseagent/agents/datawise_agent.py` 的 `_self_debug_filter` 调用 `_execute_cells(..., rerun_all=True)`；后者调用 `Session.rerun_cells()`，主动重启内核并重放过滤前保留的历史，再验证筛选代码。这属于核心过滤阶段，不是故障后的自动恢复。

过滤和规划回退阶段的已知历史重放保留；未知执行、状态丢失、取消或关闭后拒绝恢复。宿主销毁旧计算容器后建立新会话，仅重新发布原输入，清除派生文件，记录独立 kernel epoch；重放执行与原执行共享总次数和任务截止时间。官方重放可能包含调试单元，实际每次执行均计账。该调整已获用户授权，并同步到设计、规格与配置。

真实 Docker 检查已通过：官方 FST 完成规划回退、报错修复、过滤及报告交付，共 7 次受控模型调用、两个重放 epoch；另验证旧状态消失、额度不重置、未知内核状态拒绝重放。冻结阶段接入及四方法注册仍未完成。
