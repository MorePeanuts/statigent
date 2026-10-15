# 研究对比方法

分析对比为 ReAct、AutoGen、DatawiseAgent；建模增加 AutoGluon。方法清单与身份由 `src/baselines/catalog.ts` 管理，环境安装和镜像构建见 [环境说明](../environments/baselines/README.md)。软件验收状态见 [分层记录](baselines-validation.md)，不能由注册成功推断真实模型效果。

## 执行和预算

ReAct 为本地单角色推理/执行循环，保留全部历史，无 findings/evidence_refs 完成门槛，与项目单角色消融不是同一方法。AutoGen 使用官方 AssistantAgent + UserProxyAgent，只有助手调用 LLM，执行代理无人类输入、无 LLM；每轮新 Python 进程，任务内文件可复用。DatawiseAgent 保留固定官方 FST 与持久内核，允许过滤/规划回退的已知历史重放；未知执行、内核丢失或取消后不得重放。

全部模型调用由宿主同一个父账本限制尝试次数、token 与截止时间；上游缓存和 SDK 重试禁用。完整供应商消息历史（含推理字段）保留。Python worker 只负责受信编排，不能执行生成代码；生成代码只在非 root、断网、受资源限制的 Docker 中执行。受信 worker 接收公开任务视图；消息有身份、顺序、长度和超时检查。异常退出、取消与超时联动停止所属执行器，清理无法确认时停止评测批次后续派发。普通 uv 环境不被视为安全隔离。

分析必须显式提交文本或已收集的报告路径；日志不代替答案。报告只交付实际引用且通过类型/限额验证的图片。轨迹按实际执行顺序记录，包括重放，截断带标记。宿主保存独立 `baseline.json`、结构化事件及执行记录。

## 搜索、冻结和预测

搜索只发布允许的训练材料，不发布测试特征和标签。Agent 将已经拟合的模型与 `predict.py` 写入 `/tmp/baseline-models/<bundle>`，显式登记 bundle。入口接受 `--features`、`--output`、`--schema`，schema 内含冻结公开协议与 seed；输出必须满足协议的行身份、目标顺序、类别及概率定义。

ReAct 使用 `register_bundle`/`finish` 动作；AutoGen 可发送 `STATIGENT_BUNDLE` 加 JSON，DatawiseAgent 在 markdown 单元中使用同一标记。登记字段为 `bundle`、`entrypoint`。最终交付为 `STATIGENT_FINAL` 加包含 `kind: predictions` 的相同字段；DatawiseAgent 同时使用其原有完成标记。预算终止只允许已登记、执行状态已知的 bundle 使用预留时间交付，不再次调用模型或猜测文件。

冻结时停止容器中任务进程，由受信采集器流式读取模型目录，再终止搜索容器。禁止目录越界、链接和特殊文件；全文件 SHA-256 清单、独立大小/文件数限额与镜像身份形成 bundle 身份。报告文件限额不会截断模型。冻结后的目录只读，预测前后都复核全文件身份。

独立预测容器只有只读模型、测试特征和公开说明，没有训练数据、搜索工作区、凭据或 LLM 通道。入口检查常见 Python fit/partial_fit/fit_transform/fit_predict 调用并拒绝子进程；这是可观察调用审计，不是任意 Python 程序绝不拟合的形式化证明。预测失败不会返回 Agent 修复。

预测清单 v2 使用类型化 producer/model_bundle 身份，不伪造 Statigent 实验或确认记录。v1 沿用原校验和评分路径。评分只需要冻结预测与评分端材料，不加载模型目录。

```sh
bun run evaluate reproduce --run runs/…/BASELINE_RUN_ID --out runs/NEW_REPRODUCTION --timeout-ms 60000
```

复现重新验证完整 bundle，在新容器预测，保存独立身份与结果。标签/排名精确比较，数值/概率沿用固定 `atol=1e-8, rtol=1e-6`；不根据结果放宽，也不修改原运行的未复现状态。复现入口不调用模型，超时和取消保留失败记录。

## AutoGluon

固定 AutoGluon 1.4.0，CPU best_quality，GBM/CAT/XGB/RF/XT/NN_TORCH 六家族、5 折、1 层 stacking、串行训练，不下载预训练权重。记录有效展开参数及实际成功模型；配置列出的六个家族是候选集合，预算内未完成的家族不会伪报为已训练。学习器使用任务 seed（多目标依次递增）；冻结前调用官方 save_space 移除显式训练表、标签和 OOF 缓存。每个目标单独训练，排除全部目标列，剩余训练时间按剩余目标均分；每目标 fit 软限额先减去 `min(10 秒, 20% 目标额度)`，给保存和清理留出时间；外层总截止时间和预测预留不因目标数增加。当前协议支持单目标回归和多标签多目标；多输出回归为后续协议扩展。

内部指标映射覆盖当前全部 18 个 metric ID。RMSE、MAE、median absolute error、R2、accuracy、micro-F1（单标签等价 accuracy）、AUC 与逐目标 AUC 使用对应官方 scorer 并校验冻结定义的有效域。三种 RMSLE、两种 SMAPE、Gini、等级 kappa、top3、普通及 inferred-binary log-loss 使用公开核心自定义 scorer。普通 log-loss 也使用自定义实现，以避免上游固定 epsilon 与冻结 sklearn 公式的差异。未知指标和未定义边界拒绝，不自动切换代理指标。二分类内部正类固定编码为 1，交付恢复公开类别顺序；同概率按公开顺序打破并列。

## 开发配置与显式冒烟

`configs/evaluations/baselines/` 下五份基准配置分别覆盖 InfiAgent、DSBench Analysis、DAComp、DSBench Modeling、TabArena Lite。包含本方法及已确认 baseline，沿用既有任务和开发暴露声明。同一分析计划统一 1 CPU / 1 GiB（沿用现有 EDA 默认），同一建模计划统一 2 CPU / 4 GiB；LLM profile 和每单元模型/时间额度相同，批预算覆盖完整矩阵。AutoGluon 不需要 profile、不消耗 token，但计算时间计入批账。执行库、内部验证和交付预留仍有方法差异，不能称所有内部条件完全一致。

```sh
bun run evaluate plan --config configs/evaluations/baselines/dsbench-modeling.json
bun run test:smoke:baselines --preflight --scope configs/evaluations/baselines/scope-analysis.json
bun run test:smoke:baselines --preflight --scope configs/evaluations/baselines/scope-modeling-agents.json
bun run test:smoke:baselines --preflight --scope configs/evaluations/baselines/scope-modeling-automl.json
```

三个固定 scope 分别为 9 分析单元、30 Agent 建模单元和 10 AutoML 单元。可复制 scope 明确缩小任务/方法集合；缺失、重复或超出配置的单元会拒绝。正式执行必须显式 `--run --out NEW_DIRECTORY`，LLM scope 还需 `--allow-model-calls`，AutoGluon scope 需 `--allow-training`。预检不能带运行开关。首次失败保留并停止后续批次，不自动重试或扩容；预检不等于真实模型验收。
