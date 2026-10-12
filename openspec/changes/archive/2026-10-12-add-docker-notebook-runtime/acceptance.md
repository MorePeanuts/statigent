# 本地二次验收记录

验收日期：2026-10-12。三个子代理分别实现执行控制、Python 桥接、记录与 Notebook；主代理审查接口和故障路径，独立执行最终检查与文档命令。

## 环境与范围

- 宿主：macOS（Darwin 24.6.0）、arm64、Apple M1 Pro、8 逻辑 CPU、16 GiB 内存。
- Docker Engine：29.4.0，OrbStack；实际容器平台 `linux/arm64`。
- Bun 1.4.2、uv 0.8.22、Python 3.12.9；锁定依赖安装成功。
- 镜像：`statigent-runtime:dev`，实际 ID `sha256:c6349da36ab17c7f5bb45cda16ff9d58fef957bbf41cfed0655cbd2595939a5e`。
- 验收基于规划提交 `3de77cd683a61b44c4b659997652b8c18c81ab32` 及本次未提交实现，运行清单如实记录 `dirty=true`。本记录不是正式实验的代码快照。

## 实际结果

| 入口 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile`、`uv sync --frozen` | 通过 |
| `bun run check` | Biome、Ruff lint/格式、tsc 通过；29 项 TypeScript 快速测试及 11 项 Python 快速测试通过 |
| `bun run test:integration` | 14 项真实 Docker 测试通过（95 次断言）；5 项独立真实 Jupyter 内核测试通过 |
| `openspec validate add-docker-notebook-runtime --strict` | 通过 |
| `git diff --check` | 通过 |
| 按 `org.statigent.runtime=1` 查询全部容器 | 无遗留容器 |

Docker 验收覆盖双会话变量与文件隔离、只读输入、假密钥与私有答案哨兵不可见、断网、宿主控制接口不可见、记录目录不可写、进程与空间限制、内存耗尽、超时、取消、忽略中断后的强杀和定向清理。富输出验收包含 stdout/stderr、表格、可解析 PNG、显示更新、清屏、迟到输出、输出洪泛及超大单消息。

记录验收检查强杀后已收集快照仍可读取并校验、未收集文件标为未知、原工作文件不进入重放容器、原运行文件哈希不被重放修改，以及原成功单元在新环境失败时保留诊断。

二次审查与真实测试发现并修复了输出背压、关闭重复采集、收集完整度、派发记录期间取消及强杀重复终态等问题。重复终态已有可控传输回归及真实容器回归；最终完整入口在修复后通过。

## 文档命令复核

已逐条运行 `runtime demo`、`inspect`、`export`、`replay`、`demo ... timeout`、`demo ... restart` 和 `cleanup`。实际本地记录保存在 Git 忽略的 `runs/`：

- 正常示例：`4cb6db68-1605-45ab-ba68-6ba70234a52a`；4 行 CSV，A/B 均值分别为 2/4，三个单元成功，Notebook 导出通过。
- 独立重放：`2a59346e-38e2-4078-af29-f7e051395a58`；关联上述原运行，结果 `passed`。
- 超时示例：`60d1ec58-3c78-4fd9-8ca9-9df5339c1300`；单元返回 `timed_out`，导出成功，重放资格拒绝并记录原因。
- 重启示例：`125a5dc9-8270-4f36-8e26-cd8721dd6b98`；新 epoch 读取旧变量返回 `NameError`，分别导出两个 Notebook，拒绝重放验证。

实现与工程接入已完成；模型接入、智能体决策、正式 Benchmark、大规模实验及 Linux 服务器部署未在本变更进行。Notebook 格式通过和代码重放通过不代表一般分析正确性。仅验收了本机原生 `linux/arm64` 镜像；服务器架构与长时间稳定性在后续部署时验证。
