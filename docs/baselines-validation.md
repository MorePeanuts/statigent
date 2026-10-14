# 研究 baseline 开发验收

变更 `add-research-baselines`，实现进行中；本文只记录实际运行结果，不表示四种方法已接入评测。

2026-10-15，macOS arm64，Bun 1.4.2、uv 管理的 CPython 3.12.9：

| 层次 | 实际状态 |
| --- | --- |
| 方法来源/严格配置/默认矩阵 | 3 个单元测试通过，29 个断言；TypeScript 检查通过 |
| AutoGen 0.2.35 无模型导入 | 通过；实际角色、ModelClient 和 CodeExecutor 接口可用 |
| DatawiseAgent 固定源码导入 | 通过；66 文件身份校验、实际 FST/模型/执行器阶段接口可用 |
| AutoGluon CPU fit/save/load/predict | Linux arm64 Docker 通过；六类模型、两层模型及 weighted ensemble 实际训练，重新加载预测一致 |
| 实际对话/FST 受控响应 | 未运行 |
| 两个计算镜像资源探针 | 通过；UID 10001、2 CPU、4 GiB、断网、只读根目录及 8 MiB 独立写入额度实际验证 |
| JSONL 协议与运行记录 | 4 个 TS 协议测试、1 个记录测试、7 个 Python 协议测试通过；尚未接入实际 worker |
| 完整 Docker 生命周期与冻结预测 | 未运行 |
| 评测计划/运行/评分/比较/独立复现 | 未完成 |
| 真实模型开发冒烟 | 未运行，需明确 scope/预算及授权 |
| 正式实验 | 未运行 |

DatawiseAgent 首次导入缺 `websockets`，补齐其原始版本后暴露上游模块导入即创建 OpenAI 客户端的问题；通过独立导入边界禁用直连 SDK/dotenv 后复验通过。未使用 API 密钥，未产生模型消费。这些是环境修复记录，不是正式任务失败重跑。

AutoGluon macOS 首次缺 libomp；安装 23.1.3 后六家族混合训练卡在 PyTorch `sqrt` 的 OpenMP barrier，采样可见不同 libomp 地址。已定向终止，macOS 原生训练仍未通过；不把修复依赖导入记为训练通过。部署/验收使用 Linux arm64 Docker，全部模型家族保持不变，实际 fit/save/load/predict 约 5.95 秒，含容器启动与清理约 12.90 秒，父进程设置 240 秒硬截止。共同镜像探针约 4.95 秒。探针使用合成数据和缩小参数，不能代表正式任务耗时。

首次通过的镜像身份见 [images.json](../environments/baselines/images.json)。原始构建日志、失败诊断和三份 Docker 探针结果位于忽略 Git 的 `runs/baseline-environment-validation/`；未提交模型、数据或完整运行轨迹。后续镜像包含源码更新时必须重新构建并登记新摘要，不能把旧摘要称为新环境。

安装命令、来源和依赖差异见 [可选环境说明](../environments/baselines/README.md)。上游导入通过不代表边界桥接、完整阶段转换或研究效果已经验收。
