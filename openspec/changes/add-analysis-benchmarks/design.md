# Design

## Context

动机见 [proposal.md](proposal.md)，行为契约见本变更的 6 份 delta specs。这里只记录影响实现的现状：

- 评测契约（`src/evaluation/contracts.ts`）为 v1：`output.kind` 只能是 `text`；`Submission.artifacts` 是 base64 内联，单个 1 MiB、总计 4 MiB；`BenchmarkAdapter.score()` 被设计为确定性、无成本的评分；`aggregate.ts` 只计算逐单元等权平均。InfiAgent 已按 v1 产生过真实批次记录，必须保持可读。
- `publishInputs` 对每个单元复制输入文件，并在复制前后各校验一次 SHA-256。DAComp 的 100 个 SQLite 中，中位数约 3.7 MB，92 个不超过 100 MB，最大的 `dacomp-061` 约 3.5 GB；文件头显示全部使用回滚日志模式（非 WAL），可以在只读挂载下读取。
- Statigent 运行时会把工作目录中的文件扫描为带 ID 的产物；`finish_analysis` 只有 summary/findings/methods/limitations 四个字段。智能体 profile 的 `max_output_tokens` 为 4096，不足以把长报告放进工具参数。
- `src/models/client.ts` 只支持字符串内容和带工具的请求；profile 校验要求能力字段严格匹配，目前没有视觉能力字段。
- DAComp 上游评分（`benchmarks/dacomp-da/evaluator/upstream/.../evaluation_suite`）：rubric 输入优先使用轨迹（`core/tasks.py:81`）；GSB 比较只使用报告和图片；图片以 base64 `image_url` 发送；GSB 原始分以 ±3 为阈值映射到 -1/0/1，平均后取 `max(0, ·)`；总分按 0.6/0.1/0.1/0.2 加权；解析失败最多重试 10 次；缺失的 GSB 比较被跳过，剩余比较照常平均。上游模块在导入时依赖 openai、loguru 和 tenacity。
- DSBench-Analysis 上游（`compute_answer.py`）每题调用一次 `gpt-4o-2024-05-13`（temperature 0），输出转小写后含 `true` 即判对，异常一律判错；本地缺少上游的作答 Notebook。38 个案例中有 `.xlsb`/`.xlsm`、5 张图片，案例 `00000006` 含 `get_results.ipynb`。执行镜像目前没有 Excel 读取库。

## Goals / Non-Goals

**Goals:**

- 契约只升级一次，同时满足报告、图片和评委评分的需要，并为预测文件和跨方法汇总留出明确的扩展点。
- 评委复用现有模型 profile、凭据隔离和用量记录，不维护第二套 HTTP 客户端。
- 尽量保持上游评分语义；每一处偏离都写进评分协议记录。

**Non-Goals:**

- 不实现评委多次重复评分取平均、评委间一致性分析或费用换算。
- 不让智能体“看”图片；EDA 仍然只获得图表的保存引用。
- 不复现 DSBench 上游的作答设置（其 Notebook 不在本地），只复现其判定口径。
- 不做并行评分；评委调用按单元串行进行。

## Decisions

### 1. 契约 v2 与 v1 只读兼容

新增 v2 的 `PublicTask`、`Capabilities`、`Submission` 和 `Score`，v1 校验器保留，只用于读取。新批次一律写 v2；`inspect` 和 `score` 根据记录的 `schema_version` 选择校验器，不迁移、不改写旧文件。

- `output`：`{kind: "text", instructions}` 或 `{kind: "report", instructions, report_file, image_types, max_images, max_image_bytes, max_report_bytes}`。
- `Capabilities.output` 改为支持的类型列表，并新增 `trajectory: "unified" | "none"`。
- `Submission` 不再包含 base64，改为 `deliverables: {path, bytes, sha256}[]`，由评测层扫描冻结后填写；`answer_text` 保留，报告任务可以为空。
- `Score` 增加 `judge`（评委用量摘要与偏差标记，确定性协议为 null）。

相比在 v1 上做可选字段的扩展，显式 v2 能让旧记录的语义保持不变，也避免“未知字段一律拒绝”的校验被放松。

### 2. 单元交付目录与冻结

每个单元获得 `units/<unit_id>/deliverables/`。适配器写入文件后，评测层执行以下步骤：扫描（拒绝符号链接和非普通文件）→ 校验数量和大小 → 计算哈希 → `chmod 0444` → 写入交付记录。评分端只接收冻结目录的路径和哈希清单，评分前再次校验哈希。

外部命令仍使用现有的单请求/单响应协议，`artifacts` 中的 base64 由宿主解码后写入交付目录。没有改用挂载输出目录，原因是可写的 bind mount 无法限制容量，而 tmpfs 中的内容无法在容器退出后用 `docker cp` 取出。单文件和总量上限改为可配置，默认提高到 8 MiB / 32 MiB，并写入快照。

### 3. 大输入使用写时复制发布

`publishInputs` 优先使用 `COPYFILE_FICLONE`（APFS/Btrfs 克隆），文件系统不支持时退回普通复制，并记录实际采用的方式。完整性校验保持不变。开发清单按数据库大小设上限，避免开发阶段反复处理 3.5 GB 的文件。正式实验是否纳入超大库由正式清单决定。

### 4. 评委作为评分侧服务

新增 `src/evaluation/judge.ts`：

- 基准适配器声明 `judge_roles: {id, needs: ("text"|"vision")[]}[]`；评测配置的 `scoring.judges` 把角色映射到 profile ID；`scoring.budget` 声明逐单元和整次评分的请求次数、token 与时间上限；`scoring.parse_retries` 默认为 2。
- 预检检查映射完整性、能力和凭据，在执行任何智能体之前完成。
- 评委调用使用新的“无工具单轮”客户端入口。每次尝试写入 `scores/<score_id>/judge/<unit_id>.jsonl`，包括角色、profile、请求摘要（rubric 和参考报告只记哈希，不重复存储大文本）、有界的原始响应、解析状态和用量。
- `BenchmarkAdapter.score()` 接收一个受限的 `JudgeClient` 句柄，只能按已声明的角色发起调用，由句柄统一扣减预算。确定性适配器不使用该句柄。
- 若评委 profile 的请求模型名与被评测智能体的模型名相同，就标记 `self_preference_risk`。

使用 TypeScript 发起评委调用，而不是交给 Python 子进程，原因有三：可以复用凭据隔离和用量记录；评分子进程无需接触密钥；预算能够统一扣减。

### 5. 上游 prompt 与解析采用移植加差分测试

沿用 InfiAgent 的做法，在 `python/statigent_evaluation/` 中移植纯函数，并保留来源和许可说明：

- `dacomp.py`：rubric prompt 和 GSB 文本/视觉 prompt 的构造（模板原文移植）、`parse_rubric_dimension_scores`、`extract_total_score`、`extract_gsb_scores`、`trans_gsb_score`，以及加权总分计算。
- `dsbench.py`：语义判定 prompt 和 `"true" in lower()` 解析。

宿主通过现有的 uv JSON 桥接分三步调用：`prepare` 根据冻结交付和私有材料生成消息列表（图片只给出交付内或参考目录内的路径），宿主负责调用评委，`parse` 和 `combine` 解析结果并给出指标。图片的读取、格式识别和尺寸校验在 TypeScript 的模型层完成（见决策 6）。

差分测试作为独立的 `upstream` 测试入口：通过 `sys.modules` 桩替换 `llm_client`、`loguru` 和 `tenacity`，导入未修改的上游模块，用合成报告和固定的评委响应比较 prompt 文本、解析结果和加权总分。整套导入上游并在运行时调用会把 openai 等依赖和上游的重试策略带进评分侧，因此不采用。

### 6. 模型层的视觉能力

- profile 的 `capabilities` 新增可选字段 `vision`（默认为 false），旧配置文件无需修改。
- `Message` 的用户消息 `content` 可以是 `string | Part[]`，`Part` 为 `{type:"text"}` 或 `{type:"image", path|bytes}`。客户端在序列化时识别格式（PNG/JPEG/GIF/WebP 的文件头），解析像素尺寸，校验上限后编码为 `data:<mime>;base64,...`。不接受 http(s) URL。
- 本地上限默认低于 DeepSeek 文档的服务端上限：单张 8 MiB、每次请求 40 张、请求体 32 MiB、单边 8192 px，请求含 15 张及以上图片时单边 4096 px。
- 新增 `configs/models.json` 中的 `deepseek-flash-judge` profile：请求名 `deepseek-flash`，`vision: true`，thinking disabled，temperature 0，`max_output_tokens` 8192。关闭 thinking 是为了对齐上游 temperature 0 的设置，同时绕开“图片与思考模式能否同时使用”这个文档没有说明的问题。这一点由真实冒烟测试验证。

### 7. DAComp 适配器

- 目录：`public/dacomp-da.jsonl` 提供 `instruction`，数据为 `public/<id>/<id>.sqlite`；评分材料为上游 `src/<id>/{rubric.txt, metadata.json, gsb_ref_*}`。版本由本地文件哈希和 `metadata/dacomp-tree` 中的来源信息组成。
- 公开任务：`goal` 为 instruction 原文；`constraints` 写明数据库只读、报告用英文、图片放在报告同级目录并用相对路径引用；`output.kind = report`，`report_file = report.md`，图片类型限 PNG/JPEG，最多 20 张。
- 评委角色：`rubric`（text）、`gsb_text`（text）、`gsb_vision`（vision）。每个单元调用 1 次 rubric、5 次文本比较、5 次视觉比较；报告没有图片时跳过视觉比较，可视化记 0（与上游一致）。
- 指标：`total`（0–100）、`rubric_ratio`、`completeness`、`accuracy`、`conclusiveness`、`readability`、`professionalism`、`visualization`。
- 偏离：任一比较在重试后仍失败时，整个单元评分失败，不像上游那样用剩余比较平均；解析重试上限 2 次（上游为 10 次）；评委模型可配置。
- 兼容模式：`scoring.options.upstream_compatible = true` 时，额外调用一次 rubric，输入为统一轨迹；指标加 `compat_` 前缀，作为另一个协议 ID 分组，不与主口径混合汇总。

### 8. Statigent 报告交付与统一轨迹

- 报告任务的 `finish_analysis` 工具 schema 增加必填字段 `report_artifact_id`，文本任务的 schema 不变。宿主依次校验：该 ID 是本次运行的产物；内容是 UTF-8 Markdown 且不超过上限；用正则提取图片引用（与上游 `!\[[^\]]*\]\(([^)]+)\)` 一致），每个引用必须是相对路径，并解析到本次运行该路径最新保存的 PNG/JPEG 产物。校验失败计入动作纠正预算。
- 报告要求通过任务约束和工具描述传达，系统提示词不变。文本任务仍记录 `eda-single-v1`；报告任务记录 `eda-single-v1+report-v1`，这样 InfiAgent 的结果仍然可比。
- 让模型通过 `execute_python` 在工作目录写 `report.md`，而不是把报告放进工具参数：报告可以分步生成，也绕开了 4096 输出 token 的限制。
- 统一轨迹（`trajectory-v1`）：按执行顺序列出每个单元的代码、状态和有界输出预览，最后附上最终报告；整体上限 256 KiB，超出部分从中间截断并标注。由适配器根据原生记录生成；外部命令适配器声明 `trajectory: none`。

### 9. DSBench-Analysis 适配器

- 任务 ID 形如 `00000032/question1`，分组键为案例 ID。`goal` 由案例 `introduction.txt` 和该题 `questionN.txt` 拼接而成；`constraints` 要求给出明确的最终答案（选择题给选项）；`output.kind = text`。
- 发布允许清单：案例目录下的 `xlsx/xlsm/xlsb/csv/jpg`，排除 `.ipynb` 和全部 `question*.txt`（本题题面已写入 goal），并记录排除原因。题目从 `public/tasks.jsonl` 读取，答案从 `private/tasks-with-answers.jsonl` 按序对齐，对齐失败时预检报错。
- 9 个案例共 140 道题没有任何数据文件。v2 的 `PublicTask` 因此允许空输入清单（v1 要求至少一个输入）；Statigent 在没有输入时仍启动会话，`/input` 为空。
- 评委角色：`equivalence`（text）。没有最终回答的单元直接记 0，不调用评委。
- 指标：逐单元 `accuracy`（0/1）；分组汇总 `case_accuracy`（先在案例内平均，再在案例间平均）。
- 执行镜像在 `pyproject.toml` 运行依赖中加入锁定版本的 `openpyxl` 和 `pyxlsb`，`.xlsm` 由 openpyxl 读取。镜像 ID 因此变化，并记录在验收中。案例里的 5 张图片智能体只能看到文件，无法理解内容，这一局限记入协议说明。

### 10. 分组汇总

评分协议声明 `summaries: {name, metric, group_by: "task_group", within: "mean", across: "mean"}[]`。目录（catalog）为每个任务提供可选的 `group`，评测层负责保存，不进入 `PublicTask`。`aggregate.ts` 在逐单元平均之外计算这些分组指标；任一组不完整时该指标为 null。TabArena 需要的跨方法汇总只在类型中预留 `across_agents` 的位置，没有实现，配置中出现时预检拒绝。

### 11. 重评、预算与 CLI

- `bun run evaluate score <id>`：对确定性协议的行为不变；对使用评委的协议，必须同时提供 `--allow-model-calls` 和 `--judge-budget <file>`，否则在发出任何请求之前退出。
- 批次运行时，评委评分在各单元执行并冻结之后进行，使用配置中的 `scoring.budget`；评分预算耗尽时，剩余单元标记 `scoring_status = not_scored`，原因为 `judge_budget_exhausted`。
- 报告与 CSV 增加智能体用量和评委用量两组列，以及 `judge_protocol`、`self_preference_risk` 两列。

### 12. 开发清单与真实验收

- DAComp：只从数据库不超过 100 MB 的任务中选择，按编号排序后等距抽取 6 题作为开发清单；冒烟取其中前 2 题。选择只读取 `dacomp-da.jsonl` 和文件大小。
- DSBench-Analysis：只从全部数据文件都是 `xlsx`/`csv` 且没有图片的案例中选择，按编号取前 3 个案例，每个案例取前 2 题，共 6 题；冒烟取第一个案例的 2 题。
- 冒烟使用智能体 `deepseek-flash` 和评委 `deepseek-flash-judge`，智能体预算与评委预算分别固定。只运行一次，结果如实记录。

## Risks / Trade-offs

- [评委与智能体是同一个模型，存在自评偏差] → 记录中自动标记；正式实验的评委选择留到后续决定，本变更不对外报告实验结论。
- [DeepSeek 的图片输入与参数组合文档不全] → 评委 profile 关闭 thinking 并设 temperature 0；先用单次视觉比较做真实冒烟，失败就如实记录并调整 profile，不改评分协议。
- [单元评分费用高：每个 DAComp 单元约 11 次评委调用，视觉比较每次约 10 张图] → 有独立评分预算、逐次用量记录；兼容模式只多 1 次 rubric 调用。冒烟后据实测数据估算正式实验成本。
- [比较失败时整单元失败，比上游严格] → 覆盖率下降会被显式报告；失败原因可查；授权后可对失败单元重评。
- [写时复制在部分文件系统上不可用] → 退回普通复制并记录；开发清单限制数据库大小。
- [EDA 无法看到自己画的图，报告对图表的描述可能失实] → 作为已知局限记录；智能体视觉能力属于以后的方法改进，不在本变更范围。
- [移植的 prompt 与上游可能漂移] → 差分测试固定上游版本哈希；上游版本变化时测试失败。

## Migration Plan

增量交付：先完成契约 v2、交付目录和 v1 兼容读取，用已有 InfiAgent 记录回归验证；再实现模型视觉能力和评委服务；然后依次接入 DSBench-Analysis（文本输出，验证评委链路）和 DAComp（报告与视觉）；最后冻结开发清单并显式运行真实冒烟。按可独立验收的阶段提交。

回退方式：停用新增的基准注册即可。v1 记录和 InfiAgent 配置不受影响。新执行镜像以新标签构建，旧标签仍可用于复现已有批次。

## Open Questions

- 正式实验采用哪个评委模型、是否对每个交付做多次评委评分。这两点不影响本变更的接口：前者只是更换 profile，后者通过多个评分身份实现。
- DAComp 是否需要一个中文评测版本；当前只接入英文版。
