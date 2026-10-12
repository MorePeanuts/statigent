# Statigent

面向探索性数据分析与预测性建模研究的智能体项目。研究定位见 [课题概览](docs/overview.md)，评测约定见 [Benchmark 协议](docs/benchmark.md)。当前已提供 Docker 持久 Python 执行底座和可配置模型的单智能体 EDA 循环；验收使用小型合成数据，尚未接入正式基准或验证论文研究收益。

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

```sh
bun run agent run --task configs/tasks/synthetic-eda.json --model deepseek-flash
```

此命令显式调用模型，需要宿主环境中的 `DEEPSEEK_API_KEY`；默认检查不会调用付费模型。结果保存在独立运行目录，包含带证据的分析报告、原始执行轨迹与 Notebook。
