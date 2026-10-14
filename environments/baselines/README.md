# 可选 baseline 环境

这些环境独立于主项目和 TabArena 官方兼容环境。Bun/TypeScript 管理任务、权限和父预算；Python 环境只运行受信上游编排或实际计算。安装和源码准备是显式操作；预检/运行使用 `uv run --frozen --offline`，不会升级依赖。

| 方法 | 固定来源 | 本地适配 |
| --- | --- | --- |
| ReAct | 本地 `react-tabular-v1`；[论文](https://arxiv.org/abs/2210.03629) | 单角色持久执行，独立于 Statigent 单角色消融 |
| AutoGen | Microsoft `pyautogen==0.2.35`，MIT；[源码](https://github.com/microsoft/autogen/tree/v0.2.35) | AssistantAgent/UserProxyAgent；独立编排环境 NumPy 1.26.4，不决定任务计算环境 |
| DatawiseAgent | `64f3164869fa2558e7385d0e33a241aee2baf37f`，Apache-2.0；[源码](https://github.com/zimingyou01/DatawiseAgent/tree/64f3164869fa2558e7385d0e33a241aee2baf37f) | 固定源码子集、边界注入；不修改上游文件 |
| AutoGluon | `autogluon.tabular==1.4.0`，Apache-2.0 | 专用 CPU 训练环境，不复用 TabArena 环境 |

运行前由清单记录配置和锁文件 SHA-256。DatawiseAgent 的 [source.json](datawiseagent/source.json) 列出 66 个文件及 Git blob/SHA-256/字节数；源码下载到忽略 Git 的 `.tools/baselines/datawiseagent/`。只包含编排包、官方配置、许可、README 和原始 requirements，不下载 evaluation 目录、历史成绩或服务入口。来源检查拒绝增删改文件及符号链接；导入探针在一次性副本运行，避免上游 logger 改写来源目录。

## 安装与导入检查

在项目根目录执行：

```bash
uv sync --project environments/baselines/autogen --frozen
uv sync --project environments/baselines/datawiseagent --frozen
bun src/baselines/environment-cli.ts prepare-source
bun src/baselines/environment-cli.ts probe --method autogen
bun src/baselines/environment-cli.ts probe --method datawiseagent
```

缺少 `.venv`、锁文件或源码时探针失败并指出环境位置；不能把清单存在视为环境就绪。源码有修改时不自动覆盖，需先检查修改并另行恢复。AutoGen 探针检查官方角色类、自定义模型客户端和代码执行接口；DatawiseAgent 探针实际导入官方 FST、模型基类、Jupyter 执行器，并检查异步阶段接口。不调用 LLM、不启动 Jupyter 或执行容器；它们尚不验证完整对话/阶段转换。

DatawiseAgent 原 requirements 混入前端、CUDA、计算库，而且遗漏 `sqlitedict`。此环境按实际编排导入闭包保留原版本、补入 `sqlitedict==2.1.0`，传递依赖见 uv.lock。源码导入需要 `autogen==0.3.0`，仅在该环境保留；独立 AutoGen 对比方法仍是官方 0.2.35。FLAML 缺少 automl extra 的警告不影响编排接口，不因此安装额外 AutoML 方法。

上游模块在导入时创建 OpenAI 全局客户端。独立 `import_boundary.py` 在导入期间禁用其默认 SDK 和 dotenv 读取；调用这些客户端明确失败，后续模型请求必须由宿主桥接处理。此处不提供真实密钥，也不以伪造密钥冒充连通性验收。

## AutoGluon CPU 探针

```bash
# macOS LightGBM/XGBoost 还需要 OpenMP 系统库：brew install libomp
uv sync --project environments/baselines/autogluon --frozen
docker build -f docker/baselines.Dockerfile --build-arg BASELINE_ENV=compute -t statigent-runtime:baselines-cpu-v1 .
docker build -f docker/baselines.Dockerfile --build-arg BASELINE_ENV=autogluon -t statigent-runtime:autogluon-cpu-v1 .
bun src/baselines/docker-probe.ts --method compute --output runs/compute-probe
bun src/baselines/docker-probe.ts --method autogluon --output runs/autogluon-probe
bun src/baselines/docker-probe.ts --method autogluon --checks-only --output runs/autogluon-resource-probe
```

Linux 锁定 CPU PyTorch wheel；macOS 使用官方平台 wheel。计算依赖固定 NumPy 2.2.6、sklearn 1.7.2、LightGBM 4.6.0、CatBoost 1.2.8、XGBoost 3.0.5、PyTorch 2.7.1。CPU 预设以 best_quality 为基础，显式 GBM/CAT/XGB/RF/XT/NN_TORCH，5 折、1 次 bagging、1 层 stacking，保留 weighted ensemble；固定关闭动态 stacking 探测，使用串行本地折训练，避免引入 Ray 调度和额外探测训练。有效参数由官方预设展开后覆盖并保存，seed 不能保证跨平台逐位相同。

探针使用 120 行合成回归数据、2 折、少量树/epoch，真实训练全部六个家族，保存并重新加载后核对预测；缩小参数与方法默认参数分别输出。探针只验证环境与计算能力，完整 baseline 流程及预测阶段隔离另行验收。

以上 Docker 探针均有 240 秒父截止，结束后只清理本次唯一容器；输出目录必须不存在。两个镜像均限制 2 CPU、4 GiB、非 root、断网和只读根目录。资源探针读取实际 cgroup 并写满独立 8 MiB tmpfs 验证额度。共同镜像新增 LightGBM/CatBoost/XGBoost；为匹配这些版本，NumPy 为 2.2.6，与旧镜像 2.3.3 的差异明确记录。旧镜像与旧配置保持原值。

macOS 原生六家族混合训练已出现 OpenMP 挂起；原生环境不标为就绪。Linux arm64 Docker 已完成全部家族真实训练与重载预测，计算部署以该环境为准。系统依赖锁定 Debian `libgomp1=12.2.0-14+deb12u1`，已验收镜像摘要见 [images.json](images.json)。

分层状态见 [baseline 验收记录](../../docs/baselines-validation.md)。默认 `bun run check` 不安装或运行这些可选环境。

## 受控桥接开发检查

```bash
bun test tests/upstream/baseline-autogen.test.ts
bun test tests/integration/baseline-execution.test.ts tests/integration/baseline-lifecycle.test.ts
```

第一条使用锁定的官方 AutoGen 双代理和受控模型/执行反馈，检查真实消息流、自主修复、推理历史、显式交付和父账；执行代理没有 LLM，不接受人工输入。仅启用 Python 代码块，额外命令返回执行错误；SDK 默认客户端不使用，缓存关闭。该检查不是 DSBench 原论文配置逐项复现。

第二条需要共同 CPU 镜像，实际运行持久内核和新脚本执行器；验证输入和产物范围、凭据/私有文件/网络隔离，以及 worker 退出、取消、超时后的定向容器清理。worker 只接收公开任务视图，Python 通过固定 uv 入口启动，环境不继承 API 密钥、代理或 CUSTOM_CONFIG。双向 JSONL 以 run_id/request_id/sequence 拒绝重复、并发、错序及迟到请求；运行事件独立写入 baseline 记录。

当前这些是基础层接口与检查，尚未注册四种 baseline，也未完成冻结预测、统一评分和冒烟命令。DatawiseAgent 的官方过滤阶段需要显式内核重启/历史重放，与提案中笼统的禁重放规则存在冲突，待明确方法边界后实现。不能以其他循环代替它并继续称为 DatawiseAgent。
