# Statigent

面向探索性数据分析与预测性建模研究的智能体项目。研究定位见 [课题概览](docs/overview.md)，评测约定见 [Benchmark 协议](docs/benchmark.md)。当前首个工程变更实现 Docker 中的持久 Python 执行底座，使用固定合成数据验收；尚未接入模型、智能体决策或正式基准。

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
