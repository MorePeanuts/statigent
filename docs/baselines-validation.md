# 研究 baseline 开发验收

变更 `add-research-baselines` 的验收分为软件接入、受控模型与真实依赖、真实模型开发冒烟和正式实验。前两层使用合成任务，不调用付费模型；它们不证明研究效果，也不能替代后两层。

验收环境为 macOS arm64、Bun 1.4.2、uv 管理的 CPython 3.12.9；实际生成代码、训练和预测运行于 Linux arm64 Docker。按用户确认，当前实现遵循冻结基准的单目标回归和多标签分类协议；多输出回归另列后续协议扩展。

## 实际运行记录

| 层次 | 结果与证据 |
| --- | --- |
| 方法与环境身份 | ReAct 本地版本、AutoGen 0.2.35、DatawiseAgent 固定 commit 的 66 文件校验、AutoGluon 1.4.0；分别锁定可选环境 |
| 上游真实接口 | `tests/upstream/baseline-{autogen,datawise}.test.ts`：4 测试、21 断言通过；实际 AutoGen 助手/执行代理修复，实际 Datawise FST 规划、调试、过滤、完成；截断响应零执行 |
| AutoGluon 指标 | 独立 AutoGluon 环境的 `test_baseline_metric_upstream.py`：19 测试通过，覆盖全部 18 个 metric ID 的实际 scorer 与公开核心差分及无效边界 |
| 资源隔离 | 最终两镜像实际探针均通过：UID 10001、2 CPU、4 GiB、禁网络、只读根目录、8 MiB 写入额度；sklearn/LightGBM/CatBoost/XGBoost 实际训练成功 |
| 分析完整链路 | 三方法通过注册、计划、运行、报告校验、评分和 compare；读取实际 SQLite 与工作簿、生成图片；父账分别为 30/30/45 个受控 token |
| 建模完整链路 | 四方法通过实际训练、冻结、独立预测、评分和 compare；外部方法使用 producer/bundle 身份，确认状态为不适用；AutoGluon 零模型调用 |
| 交付与复现 | 全文件 bundle 哈希、链接/越界/额度/后台写入拒绝；新容器预测零模型/可观测拟合调用；独立复现成功、模型篡改拒绝，移走模型目录后评分相同 |
| 任务形态 | 合成数据覆盖回归、二分类标签/概率、多分类标签/概率、等级、前三候选和多标签；AutoGluon 使用实际拟合后的模型，无测试特征参与训练 |
| 停止和失败 | 三 Agent 的无登记预算终止不猜测交付；显式登记后零新增模型调用交付；缺报告、取消、超时保留失败；Datawise 只允许已知 FST 转移重放，未知状态禁止恢复 |
| 多目标预算 | 剩余时间按剩余目标均分，目标间结余可结转；训练软限预留保存时间，总额度不复制；第二目标失败或总时间用尽不交付部分目标 |
| 历史兼容 | v1/v2/v3 批次离线检查、重评分后原文件 SHA-256 不变；同预测的清单 v1/v2 指标及 RPG 相同；旧离线入口权限检查通过 |
| 开发范围 | 五套配置的只读计划可用；最终三个 scope 预检分别为 9 分析、30 Agent 建模、10 AutoML 单元，零模型调用、零训练；缺方法/任务/有限额度或运行开关拒绝 |
| 真实模型开发冒烟 | **未运行**；已有显式入口、固定 scope 和预算，不将预检计为真实模型成功 |
| 正式实验 | **未运行**；仍需另行冻结正式任务、重复次数、预算与排除规则 |

完整快速检查与 Docker 回归的最终计数见本文末尾。检查命令、环境安装与模型目录说明见 [环境说明](../environments/baselines/README.md) 和 [方法说明](baselines.md)。预测入口的 fit 调用审计只覆盖可观测 Python 调用，不是对任意程序的形式化无训练证明。

## 失败与修复记录

DatawiseAgent 首次导入缺 `websockets`，补齐原始版本后暴露上游模块导入即创建 OpenAI 客户端的问题；独立导入边界禁用直连 SDK/dotenv 后复验通过。未使用 API 密钥，未产生模型消费。

AutoGluon macOS 首次缺 libomp；安装 23.1.3 后六家族混合训练卡在 PyTorch `sqrt` 的 OpenMP barrier，采样可见不同 libomp 地址。已定向终止，**macOS 原生训练未通过**。最终部署与验收使用 Linux arm64 Docker；首次小型探针实际训练六家族、两层模型和 weighted ensemble，fit/save/load/predict 一致。该探针约 5.95 秒，不代表正式任务耗时。

接入实际脚本桥时补齐 IPython/Matplotlib 运行依赖；AutoGluon 特殊目标测试最初出现时间额度不足，修正为每目标软限预留保存/清理时间并关闭冗余训练输出，仍保持外层硬截止及原模型家族。前三候选输出首次暴露列顺序错误，改为使用公开协议列顺序。修复后相关真实训练/预测用例通过。开发中的响应夹具缺推理字段、报告完成阶段错误等测试问题另行修正；这些记录不作为正式任务失败重跑或性能提升证据。

固定官方 Datawise FST 的过滤阶段和规划回退会主动重启并重放已知历史。宿主保留该算法行为：销毁旧容器、重新发布原输入、清除派生文件并记录 epoch；重放与原执行共享次数、token 和截止时间。真实 Docker 用例验证原状态消失、预算不重置，未知执行/内核丢失/取消/冻结后不重放。

## 镜像与证据保留

[images.json](../environments/baselines/images.json) 同时保留首次环境探针及最终源码镜像摘要。最终共同镜像为 `sha256:63674f744a4286248423ed6b35d954f0d7a98cbdacd40cbb6f6243ea5cfa7df1`，AutoGluon 镜像为 `sha256:bda69954e5c9ab4fe908a7ad1d119e7bad88cfbb029c0186281e032f25952ba7`。计划冻结方法来源与请求配置身份，运行预检再绑定实际镜像摘要和有效配置身份；报告不依赖事后变化的当前方法清单补造历史来源。

本地原始构建日志、失败诊断、探针和验收输出保存在忽略 Git 的 `runs/baseline-environment-validation/`。小型合成测试和复现命令提交 Git；模型、基准数据、凭据及完整轨迹不提交。所有 Python 调用通过 uv，付费冒烟不属于默认检查。

## 最终检查结果（2026-10-15）

- `bun run check`：Biome、Ruff、格式和 TypeScript 类型检查通过；399 个 TypeScript 单元测试及 253 个 Python 测试通过，172 个显式上游/集成等标记测试未纳入默认检查。
- `bun run test:baselines:integration`：14 个文件、46 个实际 Docker 集成测试、293 个断言全部通过，约 20.5 分钟。覆盖三方法分析与四方法建模、特殊目标、隔离、生命周期、冻结、复现、预算收尾及失败路径。
- 显式上游：AutoGen/DatawiseAgent 4 个测试通过；AutoGluon 实际指标 19 个测试通过。两份最终镜像资源探针均通过。
- 完整比较计划的单元数为 InfiAgent 48、DSBench Analysis 24、DAComp 24、DSBench Modeling 35、TabArena Lite 15；包含本方法，不等于三个 baseline 专用冒烟 scope 的 9/30/10 单元。
- `openspec validate add-research-baselines --strict` 与 `git diff --check` 通过；提交范围不含运行模型、基准数据、凭据或完整轨迹。
- AutoGluon 多标签冻结 bundle 的额外独立复现复验：1 个测试、9 个断言通过；新容器预测在固定容差内一致，模型调用与可观测拟合调用均为 0。该复验没有追加训练预算或放宽比较容差。
