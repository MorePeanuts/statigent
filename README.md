# Statigent

面向探索性数据分析与预测性建模研究的智能体项目。研究定位见 [课题概览](docs/overview.md)，评测约定见 [Benchmark 协议](docs/benchmark.md)。当前已提供 Docker 持久 Python 执行底座、可配置模型的单智能体 EDA 循环，以及接入 InfiAgent-DABench 的统一评测层。开发验收与正式实验分开，尚未验证论文研究收益。

本地开发采用 Bun + TypeScript 控制层、uv 管理的 Python 内核桥接，macOS 的 Docker Linux 容器可完成开发和集成验收。大量实验的 Linux 服务器部署另行进行。

```bash
bun install --frozen-lockfile
uv sync --frozen
bun run check
docker build -f docker/Dockerfile -t statigent-runtime:dev .
bun run runtime demo
bun run test:integration
```

检查入口、镜像依赖、配置、Notebook 导出与重放、超时/重启和定向清理见 [执行环境说明](docs/execution-runtime.md)。实际运行产物保存在 Git 忽略的 `runs/` 下。默认快速检查不调用模型、不下载基准、不启动 Docker；Docker 集成测试单独运行。

## EDA 智能体

自然语言任务入口、DeepSeek 与自定义模型配置、预算/用量口径及验收命令见 [智能体使用说明](docs/agent.md)。

EDA 支持默认单角色与 `planner-executor` 双角色组织。双角色采用提示词引导的适中委派粒度，执行者在同一内核中多步求解，规划者依据返回证据继续委派或交付报告；两角色共享总预算。合成报告示例：`bun run agent run --task configs/tasks/collaboration-report.json`。开发评测预览：`bun run evaluate plan --config configs/evaluations/infiagent-collaboration-smoke.json`（预览不调用模型）。

```sh
bun run agent run --task configs/tasks/synthetic-eda.json --model deepseek-flash
```

此命令显式调用模型，需要宿主环境中的 `DEEPSEEK_API_KEY`；默认检查不会调用付费模型。结果保存在独立运行目录，包含带证据的分析报告、原始执行轨迹与 Notebook。

## 评测入口

统一评测支持基准与智能体独立适配，首版接入 InfiAgent-DABench、现有 EDA 及离线容器命令协议。使用方式、评分口径和开发集合见 [评测说明](docs/evaluation.md)。

软件检查、真实三题 DeepSeek 冒烟及离线重评结果见 [评测验收记录](docs/evaluation-validation.md)。

```sh
bun run evaluate plan --config configs/evaluations/infiagent-smoke.json
```

该命令只预览和校验计划。真实模型评测必须显式使用 `run`；无需 API 的完整示例使用 `configs/evaluations/synthetic-command.json`。

## 预测建模

回归、二分类和多分类共用独立建模入口、固定划分、定向 EDA、模型交付与预测复现，见 [建模说明](docs/modeling.md)。准备数据不调用模型；`modeling run` 与 `test:smoke:modeling` 为显式真实模型入口。分类冒烟使用 `test:smoke:classification --kind binary|multiclass`，加 `--preflight` 仅校验冻结任务。当前覆盖小型开发闭环，真实分类模型验收状态见 [分类验收记录](docs/modeling-classification-validation.md)，不代表完整建模基准或正式研究实验。
