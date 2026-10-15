# 统一评测

评测层通过独立的 BenchmarkAdapter 与 AgentAdapter 连接基准和智能体。注册发生在受信代码中；配置只选择注册 ID，不动态加载外部插件。公共任务包含目标、约束、明确输入清单和输出契约；私有标签只交给评分端。新批次使用契约版本 3，未知版本、字段及不支持的能力会被拒绝；版本 1/2 的旧批次仍可只读检查和重新评分。既有分析适配器及 container-command 保留原 v2 调用格式。

智能体只需返回终态、明确最终回答、交付文件和用量，无需使用 Notebook 或 Statigent 的角色/工具实现。模型配置复用 `configs/models.json`，用量区分模型返回的测量值、外部自报告、未知与不适用。缺失遥测不能记为零。

| 适配器 | 输出类型 | 统一轨迹 | 模型控制 | 执行种子 | 隔离 | 用量 |
| --- | --- | --- | --- | --- | --- | --- |
| statigent-eda | text、report | unified（trajectory-v1） | 现有 model profile | Python 执行，非模型采样保证 | Docker | 请求日志与模型返回用量 |
| container-command | text、report | none | 无模型，首版不联网 | 由协议提供 | Docker | 无模型调用时不适用 |
| statigent-modeling | predictions | none | 同一 profile 供建模与子 EDA 使用 | 内部分割与实际拟合 | Docker | 只结算已审计原生父账 |
| deterministic-modeling | predictions | none | 固定预处理和决策树，无付费 LLM | 内部分割与实际拟合 | Docker | 付费调用不适用，原生训练次数另记 |

模型预算包含尝试次数、token 停止阈值；响应可能使 token 超出阈值，阈值不是账单硬上限。相同智能体可以注册多个配置分别比较。分析适配器接受 text/report；`statigent-modeling` 与 `deterministic-modeling` 接受 predictions。

## v3 预测契约

`predictions` 输出声明完整目标协议、准备清单路径、规范预测/官方导出/身份清单文件名，以及独立的数据限额和总交付字节限额。公开输入必须逐一列入 `phase_inputs` 的 search、eda、confirmation、final_fit、prediction 白名单；私有 evaluator、private、upstream、raw 文件不能列入公开输入。适配器还需声明 v3 `phase_isolation=true` 和 predictions 能力，旧分析或容器命令适配器在计划阶段拒绝这类任务。

预测文件使用冻结任务声明的限额；普通报告继续使用原文件限额。读取和重评分从原冻结计划取得限额，不能靠提交文件自行放大允许值。v3 指标上下界可以为 null，例如 RMSE 无上界、R² 无下界，指标值仍必须有限；旧 v1/v2 分数继续要求有限上下界。

调度器将五份白名单分别发布到单元的 `input/<phase>/`，优先使用写时复制并验证哈希；私有评分文件不发布。原生建模先以 training 访问模式核验训练分区，保留原清单身份且不打开测试特征或 evaluator。冻结模型后才把 prediction 阶段的指定特征追加到本次运行的预测输入，不能覆盖已有文件或再次发布。Docker 实际挂载仍限定到当前训练、EDA 或预测阶段需要的子集，阶段目录名本身不充当隔离措施。两套基准的合成确定性批次已实际通过训练、预测、冻结及移走原生模型后的重评。

## 建模基准的显式数据准备

`evaluate prepare` 独立于 plan/run。它不读取模型配置、不调用 LLM、不训练或下载；
默认计划入口不会隐式生成准备目录。`dsbench-modeling`、`tabarena-lite` 只接受已准备目录，
准备通过只能作为数据层证据，实际训练范围见 [建模基准验收记录](modeling-benchmarks-validation.md)。

```bash
uv sync --frozen --group data
mkdir -p runs/prepared
bun run evaluate prepare --config configs/evaluations/dsbench-modeling-prepare.json --out runs/prepared/titanic
bun run evaluate prepare --config configs/evaluations/tabarena-modeling-prepare.json --out runs/prepared/airfoil
bun run evaluate prepare --config configs/evaluations/dsbench-modeling-prepare.json --reuse runs/prepared/titanic --receipt runs/prepared/titanic-reuse.json
```

配置显式指定一个候选、来源清单、种子、五项数据限额与准备时限。输出及回执必须不存在；
新建默认回执是 `<out>.preparation.json`，可用 `--receipt` 指定其他新文件。
已有目录不得覆盖，也不能向原始基准树写入准备产物；复用必须显式使用 `--reuse`。
复用会重新验证源文件、准备文件、划分、协议及配置身份，保存本次校验耗时和原始成本文件的哈希，
不会把历史准备报告为本次免费完成。`dataset.preparation.elapsed_ms` 是材料化耗时；
`preparation-cost.json` 另存完整准备/校验进程耗时，回执的 `original_cost` 引用该事实。
失败回执保存错误和本次耗时；部分准备产物保留，不能被误用为成功任务。

新数据清单为 schema 3，目标协议为 v2；旧原生 `modeling prepare` 的 schema 1/2 读取规则保留。
目录内容及发布边界：

| 目录/文件 | 内容与用途 |
| --- | --- |
| `search/train.csv` | 允许训练成员及全部目标；预测特征采用冻结白名单 |
| `search/features.json`、`split.json` | 完整特征类型、缺失编码和内部成员 |
| `search/task.txt`、`adaptation.json` | 原题面或公开任务说明、实际发布规模及协议勘误 |
| `final-prediction/test.csv` | 冻结后才可发布的无标签测试特征 |
| `evaluator/labels.csv`、`source-rows.jsonl` | 私有评分标签与来源/导出身份映射 |
| `dataset.json`、`preparation-cost.json` | 受信调度端使用的身份、限额、哈希及成本事实 |

这些目录名不是安全沙箱。实际执行必须按阶段只挂载白名单文件，不能把准备根目录整体挂载给智能体。

准备后的批次在 `benchmark.options` 显式声明 `prepared_root`、`datasets`（任务 ID 到相对准备目录的映射）和私有原始材料根 `data_root`。`benchmark.version` 必须等于该组准备数据的 `source_revision`，不能混用来源版本。两套基准分别建批次；TabArena 固定 r0f0。

原生 agent 的 `options` 使用 `image`、`method`、`confirmation`、`resource_version`、`budget`、`limits`。四种方法为 `no_eda`、`initial_eda`、`adaptive_eda`、`collaborative`；确定性验收只接受 `no_eda`。`model_attempts`、`total_tokens`、`task_timeout_ms` 由统一父预算控制，不能在原生 options 中重复覆盖；输入发布及内部划分准备消耗剩余时间。确认/最终拟合预留不随余额缩小，余额不足时在首个模型请求前拒绝。子 EDA 已计入原生父账，批次不得再相加；未知用量阻止后续受预算约束派发。

重复实验使用 `seed + repetition`。种子不等于准备种子时，只在运行目录派生内部划分，冻结外层成员和数据字节，记录 `dataset-seed-v1` 身份与独立准备耗时；显式内部划分保持原成员。若类别覆盖不满足协议则失败，不重新抽种子。关闭跨单元缓存，每个确定性单元也必须实际训练和预测。

```bash
# CONFIG 是显式选择上述准备目录、任务、agent、种子及有限预算的批次配置。
bun run evaluate plan --config CONFIG
bun run evaluate run --config CONFIG --root runs/evaluations
bun run evaluate inspect EVALUATION_ID --root runs/evaluations
bun run evaluate score EVALUATION_ID --root runs/evaluations
bun run evaluate compare EVALUATION_ID --score-id SCORE_ID --root runs/evaluations
```

`plan` 只读校验准备数据和评分资源，不训练或调用模型。成功交付恰含 `predictions.csv`、`export.csv`、`prediction-manifest.json`（文件名由输出契约冻结）；模型保留在原生目录，清单记录模型、原生交付和预测哈希。受信导出器按发布行序还原 DSBench 列，TabArena 导出源行号及原尺度预测/正类概率/完整类别概率。文件缺失、超限、集合变化或篡改均拒绝。`score` 生成新的评分身份，读取冻结预测及私有标签/参考，不读取模型，不改变原交付及原评分。

逐题原生值保留在 `score.details.native` 和 CSV 的 `native_value`，不跨任务平均异尺度指标。主汇总仅包含完成率及 DSBench RPG。执行失败计完成率 0、RPG 0；未运行或评分材料/计算错误使完整汇总为 null。RPG 不截断大于 1 的结果；TabArena 官方误差映射另列，固定官方环境差分是否实际执行须另看验收记录。

`compare` 是独立、零模型调用的配对导出入口，只读指定既有 `SCORE_ID`，在 `comparisons/<id>/` 写入 `pairs.json`、`pairs.csv`。按任务、配置、种子、重复保留所有计划行，包括失败及未运行；记录原评分文件哈希，不生成排行榜或启用 `cross_agent_summary`。搜索结束原因、交付/预测/独立复现状态、确认、预算、父账、墙钟和准备复用身份分列。报告生成不会执行独立复现，复现状态明确为 `not_run`，实际复现记录及额外成本须另行关联。

## 契约版本（现有评测 v2）

版本 2 相对版本 1 的变化：

| 对象 | v2 字段 | 说明 |
| --- | --- | --- |
| PublicTask | `output.kind` 为 `text` 或 `report` | 报告类型另含 `report_file`（必须是 `.md` 相对路径）、`image_types`（`png`/`jpeg`）、`max_images`、`max_image_bytes`、`max_report_bytes` |
| PublicTask | `inputs` 可以为空 | 用于没有数据文件的题目；v1 仍要求至少一个输入 |
| Capabilities | `outputs`（列表）、`trajectory`（`unified`/`none`） | 计划要求的输出类型不在 `outputs` 中时，预检拒绝 |
| Submission | `deliverables`、`trajectory` | 取代 v1 的 base64 `artifacts`；清单由评测层扫描冻结后填写，适配器返回空列表 |
| Score | `judge` | 评委用量与偏差标记；确定性协议为 null |
| 配置 / plan / manifest | `scoring`、`groups` | 评委映射与评分预算；分组汇总所需的任务分组 |

读取时 v1 对象在内存中转换为 v2 形状：文本输出不变，`artifacts` 映射为位于 `units/<unit_id>/artifacts/` 的交付并逐一校验哈希，Score 的 `judge` 为 null。磁盘上的 v1 文件不会被改写，计划哈希按原始内容校验。

报告任务的公开契约示例：

```json
{
  "schema_version": 2,
  "id": "dacomp-002",
  "version": "example",
  "goal": "Analyze the growth trend of Sales Amount for each Major Category.",
  "constraints": ["The database is read-only."],
  "inputs": [
    {
      "path": "dacomp-002.sqlite",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "bytes": 1
    }
  ],
  "output": {
    "kind": "report",
    "instructions": "Write report.md in English and reference charts by relative path.",
    "report_file": "report.md",
    "image_types": ["png", "jpeg"],
    "max_images": 20,
    "max_image_bytes": 5242880,
    "max_report_bytes": 262144
  }
}
```

测试中的最小合成配置位于 `tests/fixtures/evaluation-config.json`，通过 `tests/helpers/evaluation.ts` 的合成注册表解析。它只验证契约和组合关系，不代表真实基准或真实隔离能力的实验结果。

## 文件记录与输入隔离

每个批次使用独立的 `runs/evaluations/<evaluation_id>/`，包含版本为 2 的评测 manifest、冻结计划、事件、units、scores 和 native 目录。这里的版本与原生执行记录版本独立。每个计划单元在调用智能体前就有记录；原生 EDA 运行只被关联，不修改它的清单和代码重放语义。一个合成命令批次的实际目录：

```text
<evaluation_id>/
  manifest.json  plan.json  events.jsonl
  native/unit-000001/                  # 原生运行（外部命令为空）
  units/unit-000001/
    input/data.csv                     # 发布的只读输入
    deliverables/result.txt            # 冻结后的交付文件（0444）
    record.json  submission.json
  scores/<score_id>/
    report.json  units.csv
    judge/<unit_id>.jsonl              # 仅评委协议产生
```

输入发布按路径、大小和 SHA-256 验证，只发布当前任务允许的普通文件，拒绝符号链接及越界。文件系统支持时使用写时复制克隆（APFS、Btrfs 等），否则退回普通复制；实际方式写入事件 `inputs_published`（`clone`/`copy`/`mixed`/`none`），两种方式都在发布前后校验哈希并设为只读。

交付目录在单元终止后由评测层扫描并冻结：只接受普通文件，拒绝符号链接、设备文件和超过 4 层的嵌套；单文件上限 8 MiB、总量 32 MiB、最多 64 个文件；逐个计算 SHA-256 后设为只读，清单写入 submission。目录不合规时整个目录改名为 `deliverables.rejected/` 留作审计，单元记为失败，并换成空的交付目录，按基准规则计分。报告类任务还会校验报告文件及其引用的图片（见契约版本一节）。评分前会重新比对文件集合与哈希，多出、缺少或被修改的文件都会让评分被拒绝。JSON 单文件上限 16 MiB、事件总量上限 16 MiB。原始数据只读，批次结果不提交 Git。

查看是只读操作。意外退出遗留的 running 状态显示为 unconfirmed，不推断成功，也不自动续跑。需要先检查记录并定向清理遗留资源；重新实验须创建新的批次身份。配置中的密钥值会被脱敏，仅保留环境变量名。

## InfiAgent 评分

适配来源固定为 InfiAgent commit `3d6c4a70198e0a41fadf539f5b43c88b8c1a2d9c`，56 项公开/私有数据及评分资源的 URL、大小与 SHA-256 保存在适配器来源清单，原始文件不修改。Python 比较函数保留上游提取与浮点语义，来源许可见 `third_party/infiagent/LICENSE`。

评分仅使用明确最终回答，Statigent 对应 `analysis.summary`；Notebook 和轨迹不用于补全缺失答案。ABQ 表示整题全对，PSAQ 是该题正确子答案的比例。主汇总每题每次重复等权，终止失败或空回答记零；未执行、状态未确认或评分基础设施错误使完整批次指标为 null，并标记 incomplete。

上游兼容结果仅包含非空有效回答，保留四位小数舍入，同时显示回答数和覆盖率。这一分母与主结果不同，不能替代完整任务成绩。默认测试用合成数据；`bun run test:evaluation:upstream` 显式使用已准备的本地上游脚本做差分校验，不下载数据。

当前固定数据中第 734 题存在重复参考答案键；按本变更的标签有效性约定，选择该题会明确预检失败。未选中任务的私有答案结构不影响所选任务。原始标签保持原样；若后续正式集合包含该题，需要显式修订评分协议，不能静默改变标签或排除规则。

## DAComp-DA 评分

适配器 `dacomp-da`，options 为 `{"root":"benchmarks/dacomp-da","metadata":"benchmarks/metadata"}`。上游评分代码固定为 ByteDance-Seed/DAComp `027ccaf20f0d3743d9291fd575d9bc785a5fe3db`，数据为 Hugging Face `DAComp/dacomp-da@2cc22149cdfe16cec41851ccae791c2d2c873bb3`（英文版 100 题）。下载器写下的逐文件清单（数据库来自官方 LFS 哈希，评分材料来自 GitHub）中属于 DAComp 的条目，其摘要固定在 `src/evaluation/benchmarks/dacomp-provenance.json`；清单与固定版本不一致时目录直接报错。建计划只核对数据库大小，预检时再对选中任务的数据库和该题全部评分材料计算 SHA-256（全部 100 题约 6.5 秒）。数据库均为回滚日志模式，可在只读挂载下打开。移植代码许可见 `third_party/dacomp/LICENCE`（MIT）。

- **任务与交付**：goal 为 `dacomp-da.jsonl` 的 instruction 原文，只发布 `/input/<id>/<id>.sqlite`，约束中提示以只读 URI 打开数据库。输出为报告类型：英文 `report.md`，图片 PNG/JPEG 最多 20 张、每张 5 MiB，报告 256 KiB。
- **主口径 `dacomp-da-report-v1`**：评委角色 `rubric`（text）、`gsb_text`（text）、`gsb_vision`（vision）。每题 1 次 rubric 打分，输入为报告全文和该题评分细则；5 次与参考报告的文本比较；报告含图片时再做 5 次视觉比较，候选图片与参考图片按上游顺序附在 prompt 后。英文模板由 `ast` 从上游 `prompts.py` 原样提取（`python/statigent_evaluation/dacomp_prompts.py`）。回复必须能按上游规则解析（rubric 需为含总分的 JSON 对象，比较需为 JSON 对象），否则在 `parse_retries` 内重新请求。
- **指标**（与上游 `get_score.py` 的列对应）：`total`（0–100）= 0.6 × rubric 得分率 + 10 × 可读性 + 10 × 专业性 + 20 × 可视化；`rubric_ratio`（0–1）；`completeness`、`accuracy`、`conclusiveness`（各维度得分占该维度满分的百分比，0–100）；`readability`、`professionalism`、`visualization`（0–1，比较原始分以 ±3 为阈值映射为 -1/0/1 后取平均，再取 max(0, ·)）。报告没有图片时可视化计 0，不调用视觉评委。
- **上游兼容口径 `dacomp-da-upstream-trajectory-v1`**：配置 `scoring.options.upstream_compatible: true` 时，额外用智能体交付的 `trajectory.txt`（trajectory-v1）做一次 rubric 打分，与主口径共用 GSB 结果，得到兼容的 `total` 和 `rubric_ratio`。兼容结果写在报告的 `upstream_compatible` 块中，不进入主汇总，也不与主口径平均。只有声明 `trajectory: unified` 的智能体可以启用，外部命令适配器会在预检时被拒绝。
- **失败与分母**：没有被接受的报告（执行失败、超时、报告不合规）时各项指标计 0，不调用评委；任一比较在重试后仍失败，整题评分失败并标记批次不完整，不用剩余比较的平均代替。
- **相对上游的偏离**：主口径只看报告（上游 rubric 优先读轨迹）；rubric 的用户问题使用任务说明（上游发布的评分材料缺少 `instruction.txt`，脚本实际传入空字符串）；评委模型可配置（上游示例为 gemini-2.5-flash）；解析重试有上限（上游最多 10 次）；比较缺失时整题失败；无报告计 0（上游会跳过缺少答案文件的题）；候选图片限于报告中通过校验的相对链接（上游静默丢弃无法解析的链接）。这些偏离写入每次计划的 provenance。

`bun run test:evaluation:upstream` 用桩模块替换 `llm_client`、`loguru`、`tenacity` 后导入未修改的上游模块，逐字节比对三种 prompt（含图片顺序与内容）、回复解析、GSB 映射、无图规则和加权总分。

**评委成本估算**：每题主口径最多 11 次评委请求（兼容口径再加 1 次），另有解析重试。DeepSeek 文档说明每张图片最多按 1024 token 计，视觉比较一次附带候选图片加一份参考报告的图片。估算方法：用冒烟批次 `judge_usage` 中实测的每题评委 token（主口径、无兼容）乘以计划题数，再按重复次数和兼容口径（约多 1 次 rubric 请求）放大；文本或视觉请求的单次开销可从 `scores/<score_id>/judge/<unit_id>.jsonl` 的逐次用量中拆分。实测数值见 [分析基准验收记录](analysis-benchmarks-validation.md)，不使用未经核实的价格换算货币成本。

## DSBench-Analysis 评分

适配器 `dsbench-analysis`，协议 `dsbench-analysis-judge-v1`，options 为 `{"root":"benchmarks/dsbench"}`。上游代码固定为 LiqiangJing/DSBench `ba786096137a5108af11c016ad3f09cdb97beefd`，数据为 Hugging Face `liqiang888/DSBench@1196d6553ec200e1262841efc89cda5954ffe89f` 的 `data_analysis/data.zip`（SHA-256 `3a53d89b…dfb4e0`）。公开索引、含答案索引、`compute_answer.py`、`show_result.py`、`data.json` 和许可证的大小与 SHA-256 固定在 `src/evaluation/benchmarks/dsbench-provenance.json`；案例文件没有逐文件上游清单，数据版本在建目录时由公开索引哈希和全部案例文件的 SHA-256 计算得出。2026-10-12 逐文件比对确认本地 38 个案例与该压缩包一致。移植的 prompt 与判定规则许可见 `third_party/dsbench/LICENSE`（MIT）。

- **任务**：每道题一个任务，ID 为 `<案例>-<questionN>`（如 `00000032-question1`），案例作为分组键。goal 为案例 `introduction.txt` 加该题题面；输出为文本，要求给出明确的最终答案，选择题写出选项。共 466 题，其中 9 个案例的 140 道题没有数据文件，以空输入发布。
- **发布**：只发布案例目录中的数据文件（xlsx/xlsm/xlsb/csv/jpg），路径为 `/input/<案例>/<文件>`；题面文件不单独发布。案例 `00000006` 自带的 `get_results.ipynb` 可能含解答，不发布，并在 provenance 的 `excluded` 中列出；上游的 `00000012/answer.ipynb` 在私有目录中。答案只从 `analysis/private/tasks-with-answers.jsonl` 读取并按题目顺序对齐，任何不对齐都在预检时报错。
- **判定**：评委角色 `equivalence`（text）。prompt 原样使用上游 `evaluate_prediction` 的文字（含 “Flase” 拼写），只包含题面、参考答案和智能体最终回答，不含案例说明；参考答案按上游用 Python `str()` 格式化（字典答案显示为 Python 表示）。评委回复转小写后含 “true” 即判对，与上游相同（因此 “untrue” 也算对）。
- **指标**：逐题 `accuracy`（0/1），主汇总为每题等权的题目准确率；分组指标 `case_accuracy` 先在案例内平均再跨案例平均。执行失败或没有最终回答的题计 0，不调用评委。
- **相对上游的偏离**：评委模型可配置（上游为 `gpt-4o-2024-05-13`，temperature 0，max_tokens 256）；评委调用失败或无法使用时记评分错误，上游记为 False；没有回答的题不调用评委；未复现上游作答设置（`eval_GPT.ipynb` 不在仓库中），只复现判定口径；案例内 Notebook 不发布。这些偏离同时写入每次计划的 provenance。

`bun run test:evaluation:upstream` 会用 `ast` 从未修改的 `compute_answer.py` 中取出 `evaluate_prediction`，配合记录 prompt 的桩客户端执行，比对 prompt 原文、请求模型与温度，并核对判定规则。

## 智能体接入

`statigent-eda` 的 options 为 `{"image":"statigent-runtime:dev"}`，通过 model_profile 选择已有模型配置。文本任务增加通用最终回答约束，原样提交 `analysis.summary`；报告任务把输出契约中的图片类型和上限传给 EDA，完成后只把被接受的报告和它引用的图片复制进交付目录（规则见 [EDA 报告输出](agent.md#报告输出)）。计划要求统一轨迹时，适配器另交付 `trajectory.txt` 并在 submission 的 `trajectory` 字段指向它。完整 analysis 和 Notebook 保留在原生目录。用量来自原生清单与请求日志；未确认请求保留已知小计并标为未知。

`container-command` 的 options 包含 image 和 argv 数组，可设置 cpus、memory_bytes、pids、workspace_bytes，以及交付上限 max_file_bytes（默认 8 MiB）和 max_files_bytes（默认 32 MiB），二者不能超过评测层上限，并写入配置快照。镜像与命令是受信配置，任务不能覆盖它们。stdin 一条 JSON 请求（不含宿主路径，输入位于 `/input`），stdout 仅一条 JSON 响应；stderr 有界。响应使用命令协议 v1：形如 v1 Submission，`artifacts` 中的 base64 文件以相对路径命名，native_run 必须为空，首版用量必须为 not_applicable。宿主校验名称和大小后把文件解码写入该单元的交付目录，再由评测层冻结；stdout 上限随 max_files_bytes 换算，stderr 最大 1 MiB。不采用可写挂载输出目录，因为宿主无法限制 bind mount 的写入量。

构建测试镜像：`docker build -f docker/evaluation-fixture.Dockerfile -t statigent-evaluation-fixture:dev .`，前提是已有 `statigent-runtime:dev`。测试命令为 `uv run --offline --no-sync --frozen --project /opt/runtime python /opt/fixture.py`。容器无网络、无宿主环境透传和密钥，只读挂载当前输入。此测试智能体用于验证协议，不是可用于真实论文对比的分析方法。

非零退出、协议错误、超限均为失败；超时和取消清理实际容器，清理错误阻止后续派发。联网、宿主 shell、未实现角色/后端等配置被拒绝。模型提供商、模型名及思考参数只通过现有模型 profile 控制。

## 批次生命周期与预算

Statigent 适配器 v2 增加 `options.organization`（默认 `single`）和 `options.budget`。原生预算允许配置 `executions`（默认 8）、`model_timeout_ms`、`rate_retries`、`code_repairs`、`action_corrections` 及 `max_request_bytes` / `max_response_bytes` / `max_trace_bytes`，均使用原生校验和默认值。`model_attempts`、`total_tokens`、`task_timeout_ms` 禁止在这里覆盖，始终取统一评测下发的有效额度。两个角色共用该额度，只读取原生总账一次，不叠加角色小计。

示例 `configs/evaluations/infiagent-collaboration-smoke.json` 固定使用一题开发任务、同一 deepseek-flash profile、20 次模型请求和 400,000 token 阈值，执行次数显式设为 12：

```sh
bun run evaluate plan --config configs/evaluations/infiagent-collaboration-smoke.json
```

预览显示组织、模型、原生预算和统一预算，不调用模型。实际 run 的预检另外保存两角色提示词版本及哈希、原生预算和轨迹映射 `planner-executor-v1`；运行清单记录批次缩减后的有效总预算。双角色仍输出 trajectory-v1，按实际执行顺序列出各单元且标注 executor/subtask，最后附规划者报告，不把委派或文字报告伪造成 Python 单元。原生 v3 报告复制其绑定的图片快照；旧原生 v1/v2 和旧评测批次仍可读取及确定性离线重评。这个配置仅用于开发，未运行则不构成实验结果。

调度顺序为任务清单、智能体配置、重复序号；每个单元最多派发一次，使用独立输入与原生运行目录。模型内部重试计入真实尝试次数，评测器不会自动重跑失败题。普通任务失败在记录、清理和成本可靠时继续；用量未知且影响整批模型预算、记录错误或清理失败则停止。

当前配置的 cache_policy 为 disabled（省略时采用此值并写入有效配置），拒绝其他策略，不跨单元复用状态或产物。重新评分记录当时的评分代码 commit/dirty 与协议版本，不把原执行版本误记为新评分版本。

派发前取逐题额度与整批剩余额度的最小值，记录 effective_budget；预算缩减标为 reduced，不能当作完整预算公平对比。超额标为 exceeded，未知用量标为 unknown。批次时间包括发布、执行和评分，后续有界资源清理的耗时另行保留。

取消和整批超时传给当前适配器，后续任务标记 not_run 并保留原因。当前任务因超时终止且用量可靠时可以按基准规则计零；未运行任务不会被偷偷删除，完整得分保持为空。定向 cleanup 只处理本批次的容器和 native 目录对应运行，不自动重新执行。

## 评委评分

部分基准的评分协议依赖 LLM 评委。协议声明评委角色及其所需能力（`text` 或 `vision`），评测配置在 `scoring` 中把每个角色映射到 `configs/models.json` 的具名 profile，并给出评分预算。评委预算与智能体预算互相独立：

```json
{
  "scoring": {
    "judges": {
      "rubric": "deepseek-flash-judge",
      "gsb_text": "deepseek-flash-judge",
      "gsb_vision": "deepseek-flash-judge"
    },
    "unit_budget": { "timeout_ms": 900000, "model_attempts": 30, "total_tokens": 400000 },
    "batch_budget": { "timeout_ms": 3600000, "model_attempts": 120, "total_tokens": 1600000 },
    "parse_retries": 2,
    "options": {}
  }
}
```

- **预检**：在任何智能体运行前完成，检查是否存在未映射角色或多余角色、视觉角色映射到的 profile 是否声明了 `vision`、以及评委凭据是否存在；任一项不满足都拒绝整个计划，不会跳过评分项、改用其他模型或记零分。`cross_agent_summary`（跨方法排名汇总）尚未实现，配置为真时同样被拒绝。
- **调用**：评委请求不带工具，每次请求受时限（单次最长 300 秒且不超过剩余预算）、请求 32 MiB / 响应 2 MiB 上限约束。限流响应按退避重试 2 次且不计入尝试；输出无法按协议解析时最多再请求 `parse_retries` 次，所有尝试都计入用量。
- **记账**：每次尝试写入 `scores/<score_id>/judge/<unit_id>.jsonl`，包含角色、profile、请求模型、服务返回的模型名和指纹、用量、有界响应文本和解析状态。评分细则、参考报告和参考答案只记录 SHA-256，不写原文；这些材料只存在于评分侧，不进入智能体的输入或后续单元。
- **失败语义**：评委超时、调用失败、无法解析或单元预算耗尽时，该单元 `scoring_status = failed`，批次标记为不完整，不按答错计零。整次评分预算耗尽或出现无法确认用量的请求后不再发送评委请求，尚未评分的单元记为 `not_scored` 并给出 `scoring_reason`（`judge_budget_exhausted` 或 `unknown_judge_usage`）。基准规则本身规定的零分（例如报告没有图片时可视化项为 0）仍按规则计分，无需评委调用。
- **报告**：分组汇总中 `usage` 只统计智能体，`judge_usage` 单独统计评委的尝试次数、token、未知请求和耗时，并列出角色到 profile/模型的映射；货币成本为 `not_computed`。CSV 每行另有 `judge_protocol`、`judge_attempts`、`judge_total_tokens`、`judge_unknown_attempts`、`self_preference_risk`。评委评分标为 `nondeterministic`，比较限制中写明“model-judged, non-deterministic scores”。
- **自评偏差**：评委 profile 的请求模型名与被评测智能体相同时，`self_preference_risk` 为 true，并在比较限制中注明。开发阶段允许这样配置，正式实验需要另行决定评委。

**重新评分**：确定性协议的 `score` 行为不变，不调用模型。对评委协议，重评会产生新的付费请求，必须显式授权并给出新的评委预算，否则在发出任何请求之前退出：

```sh
bun run evaluate score EVALUATION_ID --allow-model-calls --judge-budget judge-budget.json
```

`judge-budget.json` 只包含 `unit_budget` 和 `batch_budget`，评委映射沿用原批次冻结的配置。每次重评得到新的 score_id 和独立的评委日志；同一交付两次评委评分的结果可能不同，各自保留，不覆盖也不自动平均。

## 报告与重新评分

每次报告写入新的 `scores/<score_id>/report.json` 和 `units.csv`。JSON 保存逐题评分细节、来源和分组汇总；CSV 每行对应一个计划单元，保留执行/评分/预算/用量状态。不同模型或智能体配置分别分组，不能把不同指标混成总分。CSV 对引号与换行转义，对可能被表格软件解释为公式的文本加前缀。

例：两题一题正确、一题终止失败，主 ABQ/PSAQ 均为 0.5；第二题未运行时，指标为 null、状态 incomplete；评分器异常时 scoring_status 为 failed，不能把它当作错误答案零分。用量未知时保留已知 token 小计和 unknown_attempts；账单成本为 not_computed，不推算价格。

离线 score 先检查冻结计划、交付和产物哈希及任务数据版本，再生成新的评分身份。旧评分、原始交付、执行费用和原生记录保持不变，整个过程不调用智能体；确定性协议也不调用模型，评委协议的重评见上一节。初始评分和重评结果可直接并列核查。

## 命令与开发清单

在仓库根目录运行，依赖安装和基础镜像构建沿用 README。先完成无需 API 的完整示例：

```sh
docker build -f docker/evaluation-fixture.Dockerfile -t statigent-evaluation-fixture:dev .
bun run evaluate plan --config configs/evaluations/synthetic-command.json
bun run evaluate run --config configs/evaluations/synthetic-command.json
bun run evaluate inspect EVALUATION_ID
bun run evaluate score EVALUATION_ID
bun run evaluate cleanup EVALUATION_ID
```

`--root` 可指定评测结果根目录，默认 `runs/evaluations`；`--models` 指定模型配置文件，默认 `configs/models.json`。只有显式 `run` 会执行智能体。plan 会校验本地数据和所选标签，但不需要 API key、不启动容器。inspect 只读；确定性协议的 score 不调用模型，评委协议的 score 必须带 `--allow-model-calls --judge-budget FILE`；cleanup 只清理指定批次资源。

固定开发清单为 `configs/evaluations/infiagent-development-selection.json`，依据公开难度、概念、题目/约束的依赖需求选择 12 题，各难度 4 题，每份 CSV 最多 2 题。排除需要额外统计检验或训练依赖的公开要求；选择器不读取答案。复现选择命令是 `bun src/evaluation/development.ts`，会重新生成三个开发配置文件，应审查 diff 后提交，不能根据得分换题。

真实冒烟固定为 0、5、308 三题，使用 DeepSeek `deepseek-flash`，每题 12 次调用、100,000 token、300 秒；整批 36 次调用、300,000 token、1,200 秒。密钥来自 `DEEPSEEK_API_KEY`。先预览后显式运行：

```sh
bun run evaluate plan --config configs/evaluations/infiagent-smoke.json
bun run evaluate run --config configs/evaluations/infiagent-smoke.json
```

已记录的三题冒烟（见 [验收记录](evaluation-validation.md)）运行时 `deepseek-flash` 的输出上限为 4096；现在 profile 改为 65536，之后的批次与该记录配置不同，不直接比较。由于智能体派发前会预留完整输出上限，100,000 的逐题阈值在新配置下只剩约 3.5 万可用，重新运行这些配置前应按 [EDA 配置说明](agent.md) 评估是否调高阈值。

12 题配置是 `infiagent-development.json`，不会自动运行。

DAComp-DA 与 DSBench-Analysis 的开发清单由 `bun src/evaluation/analysis-development.ts dacomp|dsbench` 按公开信息生成，选择器只读取公开索引、文件名和文件大小，不打开评分材料或答案：

| 基准 | 规则 | 开发清单 | 冒烟 |
| --- | --- | --- | --- |
| DAComp-DA | 数据库 ≤ 100 MB（92 题），按编号取第 ⌊i·n/6⌋ 个，i = 0..5 | `dacomp-da-development.json`：dacomp-002、017、033、053、070、085 | `dacomp-da-smoke.json`：dacomp-002、017 |
| DSBench-Analysis | 数据文件全为 xlsx/csv、至少两题的案例，按编号取前 3 个案例、每案例前 2 题 | `dsbench-analysis-development.json`：00000001、00000005、00000008 各 2 题 | `dsbench-analysis-smoke.json`：00000001 的 question6、question7 |

两套配置都使用智能体 `deepseek-flash` 与评委 `deepseek-flash-judge`，智能体预算与评委预算分开声明；逐题 token 阈值（DAComp 800,000，DSBench 400,000）远高于 65,536 的输出预留。选择规则和清单写在对应的 `*-development-selection.json` 中，在真实调用前提交，开发结果不能报告为正式成绩。正式实验另行冻结配置，披露与开发题及共享 CSV 的重叠。迁移到 Linux 时使用同一锁文件、镜像构建与 CLI，调整基准根、模型环境变量和输出根；保留来源哈希，硬件与平台变化进入运行快照。

默认 `bun run check` 不启动 Docker 容器或调用付费模型。`bun run test:evaluation:integration` 显式验证测试镜像；`bun run test:evaluation:upstream` 显式验证本地上游资源。真实实验和软件测试结果分开记录。

## 第一章后端 × 角色开发对照

新增 `infiagent-backend-ablation-development.json`、`dsbench-analysis-backend-ablation-development.json`、`dacomp-da-backend-ablation-development.json`，路径均在 `configs/evaluations/`。每套配置包含 single/planner-executor × persistent-kernel/fresh-script 四组，沿用该基准 development-selection 的任务、一次重复、种子 42、模型 profile 和逐题预算，统一使用支持两后端的 `statigent-runtime:fresh-script`。旧配置不修改。

```bash
bun run evaluate plan --config configs/evaluations/infiagent-backend-ablation-development.json
bun run evaluate plan --config configs/evaluations/dsbench-analysis-backend-ablation-development.json
bun run evaluate plan --config configs/evaluations/dacomp-da-backend-ablation-development.json
```

计划只读检查任务和脚本镜像能力，不启动任务容器、不发送模型请求。分别为 12×4=48、6×4=24、6×4=24 个执行单元。整批执行预算以及有评委基准的整批评委预算均按原配置乘四，覆盖声明计划；run 的实际预检还会握手并保存真实镜像、初始化、角色提示词版本/哈希、文件策略与原生预算。实际单位预算由 invocation.effective_budget 决定，整批剩余额度缩减不能被原生 task 配置恢复。

统一轨迹仍为 trajectory-v1，新增 fresh-script-single-v1 / fresh-script-planner-executor-v1 映射。脚本按实际顺序呈现 execution_id、代码、输出和失败，双角色标记执行者与子任务；不伪造 Notebook/kernel 字段。报告与图片交付不变，原生代码导出按后端选择。长轨迹仍明确标记截断，宿主路径与密钥在交付前脱敏。

两组都保留模型历史，脚本组允许显式工作文件复用；不会强迫每轮从原始数据重算。脚本的 import/初始化、收集和清理开销计入任务总墙钟，阶段小计不再次累计。普通脚本无末尾表达式自动展示，使用 print、显式 display 和保存图片；这是实验解释中需披露的输出语法差异。开发任务已暴露，不能冒充冻结的正式评测；四组配置准备和预览不代表真实模型冒烟或研究预实验已完成。本次没有执行真实付费批次，下一步需先明确任务范围及预算。

## 第二章建模基准真实冒烟

独立入口使用版本化 scope，明确任务、方法、模型、种子和资源版本；默认运行只显示帮助，`--preflight` 只读取并验证准备数据和计划，即使环境有 API 密钥也不派发模型、不训练、不启动容器。实际执行仍会检查凭据和镜像；预检通过不等于这些外部资源可用。

```bash
bun run test:smoke:modeling-benchmarks
bun run test:smoke:modeling-benchmarks --preflight --scope configs/evaluations/modeling-smoke/scope.json
# 仅在实际付费范围得到确认后运行：
bun run test:smoke:modeling-benchmarks --run --allow-model-calls --scope configs/evaluations/modeling-smoke/scope.json --out runs/modeling-live-smoke-v1
```

预置 scope 为 Titanic 与 TabArena 363612，各执行 no_eda/collaborative，deepseek-flash、seed=17、一次重复，共 4 单元。单元阈值为 12 次模型调用、160,000 token、600 秒；两批总阈值 48 次、640,000 token、2,400 秒，子 EDA 包含在父账中；1 CPU、2 GiB，拟合 60 秒、预测 30 秒，终局预留 150 秒。token 阈值是派发门槛，最后一次响应结算可能超过阈值，实际输出上限按请求字节估计和剩余 token 预算动态缩小，额度过小时可能出现 response_length 失败。关闭重复终局确认用于小型接口验收，不能把本配置当作四方法正式实验。独立预测复现另外计时，新增模型调用和拟合均为零。

输出目录必须全新。入口保存 scope/计划哈希、代码快照、全部单元状态、配对报告、原生轨迹摘要与独立预测复现；首次失败保留，不自动重跑或换题。未知用量、未确认清理/记录或批次异常会阻止后续批次派发。验收通过要求完成交付与评分、复现通过、用量已知，并实际观察到 collaborative 的 EDA 返回后继续训练；no_eda 必须没有分析调用。只有声明协同而没有实际覆盖时，结果为 incomplete，CLI 退出非零。实际付费验收状态以 [验收记录](modeling-benchmarks-validation.md) 为准。

任务类型补充范围已准备在 `configs/evaluations/modeling-smoke-type-coverage/scope.json`：沿用固定开发清单的其余 8 项任务，分别运行 no_eda/collaborative，共 16 单元；与首批 4 单元合并为 10 题 × 2 方法。按公开类型覆盖，不依据首批得分选择；相同逐单元配置，追加批次阈值为 192 次调用、2,560,000 token、9,600 秒。该 scope 的只读预检已通过，实际执行仍须对应付费范围授权。覆盖代表类型不等于 103 个候选逐题均已运行，也不替代全部指标的合成上游差分。

## 外部研究 baseline

四种方法与既有适配器共用 plan/run/score/compare。方法来源、差异、模型冻结及 `evaluate reproduce` 见 [baseline 使用说明](baselines.md)。新比较配置和显式冒烟入口仅用于开发，默认不调用模型或训练。外部预测清单 v2 不要求 Statigent 实验 ID；旧清单 v1、历史批次与旧离线命令保留原语义。
