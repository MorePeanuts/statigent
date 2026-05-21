# Statigent 项目架构

Statigent 是一个面向数据科学任务的智能体系统。当前版本的重点是把“输入理解、数据探索、输出渲染”这条数据分析链路跑通，并保留数据建模与深度商业分析的扩展入口。

## 总体分层

项目核心代码位于 `src/statigent/`，当前主要由以下层组成：

- `benchmarks/`：基准测试适配层，统一封装 DABench、DSBench、MLE-Bench 等评测协议。
- `models/`：模型抽象层，基于 LangChain 的基础模型接口、工具绑定和结构化输出能力管理大模型配置。
- `input/`：输入层，负责接收用户提示词与数据文件，生成数据画像和结构化任务书。
- `notebook/`：Notebook Kernel 抽象层，提供面向数据分析的增量式代码执行接口。
- `exploration/`：数据探索层，以 Inspector、Reviewer、Coder、Debugger 组成多智能体探索流程。
- `output/`：输出层，把探索报告渲染为 benchmark 协议可消费的答案、报告或文件引用。
- `agents/`：顶层智能体编排层，把输入、探索和输出层连接为可评测的 `DataScienceAgent`。
- `baseline/` 与 `sandbox/`：早期 ReAct baseline 与通用 Docker 代码执行沙箱，仍用于 baseline 评测与兼容场景。

## 核心数据流

一次数据分析任务的主流程如下：

```text
用户提示词 + 数据文件
        |
        v
InputProfiler
        |
        v
DatasetProfile
        |
        v
TaskBriefPlanner
        |
        v
TaskBrief
        |
        v
StatigentDataScienceAgent 按 task_type 分流
        |
        v
ExplorationOrchestrator
        |
        v
Inspector -> Reviewer -> Coder -> NotebookKernel
        |                         |
        |                         v
        |                    Debugger
        v
ExplorationReport
        |
        v
OutputRenderer
        |
        v
OutputBundle + AgentTrace
```

跨层传递的数据结构集中定义在 `src/statigent/schemas.py`。这些 Pydantic schema 是系统边界协议，包括 `DatasetProfile`、`TaskBrief`、`ExplorationAction`、`NotebookCellResult`、`ExplorationReport` 和 `OutputBundle` 等。

## 输入层

输入层位于 `src/statigent/input/`，由两个主要组件组成：

- `InputProfiler`：扫描输入路径，识别普通文件、表格文件和压缩包，生成文件级元数据与表格画像。
- `TaskBriefPlanner`：结合用户提示词、任务说明和数据画像，调用真实大模型生成结构化 `TaskBrief`。

`InputProfiler` 当前优先支持表格数据，包含 CSV、TSV、Excel、JSON 和 Parquet 等常见格式。对于压缩包，输入层会先安全解压到工作目录，再对解压出的文件继续画像。表格画像包含行列规模、列名、数据类型、缺失率、唯一值数量、数值摘要、疑似时间列、疑似类别列和样例行。

`TaskBrief` 是输入层交给后续层的任务书，包含：

- `task_type`：任务类型，当前包括 `data_analysis`、`data_modeling`、`deep_analysis` 和 `unknown`。
- `objective`：任务目标。
- `output_type`：期望输出形态，包括简单回答、完整报告或文件。
- `complexity` 与 `budgets`：复杂度和资源预算。
- `requirements`、`analysis_hints`、`warnings`：任务约束、分析提示和风险提示。

`TaskBriefPlanner` 只负责把用户意图解析为结构化任务书。解析失败、结构化输出类型错误或模型返回不符合 schema 时，会显式抛出解析错误，而不是退回到规则兜底分类。`budgets` 由系统根据 `complexity` 固定推导，模型只能选择复杂度层级，不能自行决定轮次、代码单元、调试次数或超时时间。

## 任务分流

顶层分流逻辑位于 `src/statigent/agents/data_science.py`。

`StatigentDataScienceAgent` 实现 benchmark 侧需要的 `DataScienceAgent` 协议：

- `run_analysis_for_eval()`：完整运行输入画像、任务书生成、任务分流、数据探索和输出渲染。
- `run_modeling_for_eval()`：当前是数据建模占位实现，返回未支持状态对应的占位提交路径。

`run_analysis_for_eval()` 是分析 benchmark 已经选定的入口，因此即使任务书被模型误分类为 `data_modeling`、`deep_analysis` 或 `unknown`，也会记录 coercion trace 和 warning，然后把任务类型改回 `data_analysis` 进入探索层。该入口返回的 trace 保持 benchmark 兼容的字典列表，每个事件都包含 `agent` 和 `session`；如果探索报告暴露 orchestrator trace events，顶层智能体会把它们追加到输出渲染事件之前。

`run_modeling_for_eval()` 当前仍是轻量占位实现：不启动输入画像、规划器或探索 orchestrator，只返回一个不存在的 `submission.csv` 路径和明确的未实现 trace。

## Notebook Kernel 层

Notebook Kernel 抽象位于 `src/statigent/notebook/`。该层的目标是为数据分析智能体提供接近 Jupyter Notebook 的增量式代码执行体验。

核心接口是 `NotebookKernel`，主要方法包括：

- `start(context)`：启动执行上下文，传入输入路径、工作目录和超时时间。
- `append_code_cell(code, purpose, expected_observation)`：追加一个可持久追踪的 notebook cell，但不立即执行。
- `replace_code_cell(cell_id, code, purpose, expected_observation)`：按 cell id 替换失败或过期的代码单元。
- `execute_cell(cell_id)`：按 cell id 执行已存在的代码单元，并返回 stdout、stderr、退出码、耗时和生成物引用。
- `get_code_context()`：向 Coder 和 Debugger 暴露当前 notebook 代码上下文。
- `close()`：释放 kernel 资源。

当前实现包括：

- `DockerNotebookKernel`：真实 Docker 执行实现，用于生产路径。它在多个代码单元之间维护执行状态，使 Coder 先追加 cell，再由 orchestrator 统一执行；Debugger 可以按 cell id 替换失败代码后重试。
- `FakeNotebookKernel`：测试替身，用于单元测试中验证 orchestration 行为。

这套抽象和早期 `sandbox/DockerSandbox` 分离。`DockerSandbox` 是为 ReAct baseline 提供通用代码执行能力，`NotebookKernel` 则面向数据分析工作流，强调增量执行、artifact 管理和后续可定制性。

## 数据探索层

数据探索层位于 `src/statigent/exploration/`，当前采用 LangGraph 状态图实现四角色多智能体流程：

- `Inspector`：读取任务书、数据画像、已完成步骤和 reviewer 反馈，先输出文本计划。文本计划可以包含停止信号，也可以描述下一步探索意图。
- `Reviewer`：把 Inspector 的文本计划审查为结构化 `ReviewerPlanDecision`，只有通过审查的计划才会被转为 `ApprovedCodeInstruction`。
- `Coder`：只通过绑定的 `append_code_cell` 工具写入 notebook cell，不直接执行代码。
- `Debugger`：当 cell 执行失败时，通过绑定的 `replace_code_cell` 工具修复同一个 cell，并可通过 `record_debug_lesson` 工具记录 task-local debug lesson，供同一任务后续修复参考。

探索动作由 `ExplorationActionKind` 预定义，覆盖 schema 检查、缺失值分析、数值摘要、类别摘要、时间趋势、分组对比、相关性、异常值、数据质量校验、可视化、具体问题回答等标准 DEA 动作。同时保留 `custom_analysis`，允许 Inspector 发起自由探索。自由探索动作必须提供 `rationale`、`expected_evidence` 和 `risk_notes`，避免无约束扩散。

`ExplorationOrchestrator` 负责把四个角色和 Notebook Kernel 串起来。它的 LangGraph 节点包括 Inspector planning、plan review、code append、cell execution、debug、observe 和 final review。路由由预算、review 结果、执行状态和最终审查结果共同决定。

当前探索层已经具备：

- Inspector 文本规划和显式停止。
- Reviewer 结构化前置审查和终审。
- Coder 基于工具的 notebook cell 追加。
- Debugger 基于工具的同 cell 替换、重试和 task-local lessons。
- `ExplorationReport` 汇总洞察、证据、artifact 和执行日志。

后续可以在该 orchestrator 上扩展动作队列、跨任务经验库和更细粒度的 artifact 生命周期管理。

## 输出层

输出层位于 `src/statigent/output/`，核心组件是 `OutputRenderer`。

`OutputRenderer` 接收 `TaskBrief` 和 `ExplorationReport`，生成 `OutputBundle`：

- `status`：输出状态，包括 success、partial、unsupported 和 error。
- `content`：最终文本答案或报告。
- `artifacts`：探索过程中生成的图表、表格、报告等文件引用。
- `warnings`：执行或渲染过程中的风险提示。

当前输出层优先保证数据分析任务可以被 benchmark 协议消费。对于尚未实现的数据建模和深度分析任务，输出层提供明确的 unsupported 响应，而不是静默失败。

## 与评测层的关系

`benchmarks/` 定义统一的评测协议和适配器，`StatigentDataScienceAgent` 通过这些协议接入评测。这样做的好处是：

- baseline ReAct 智能体和新架构智能体可以共用同一套评测入口。
- 不同 benchmark 的输入输出差异被限制在适配层内。
- 新智能体可以先完成数据分析链路，再逐步扩展到数据建模任务。

## 扩展路线

当前架构保留了以下扩展点：

- 数据建模层：未来基于数据探索层生成的 EDA 结构化报告，采用带先验洞察的搜索或 MCTS 方法完成特征工程、模型选择、训练和提交文件生成。
- 深度分析层：`deep_analysis` 已作为任务类型进入 schema，可在未来扩展为商业数据分析报告生成流程。
- 多轮探索：进一步强化 Inspector 的迭代决策，让简单任务快速收敛，让复杂任务在预算内持续发现证据。
- Artifact 生命周期：目前分析工作目录会保留在磁盘上，保证 trace 和输出中的文件路径可检查。未来可以增加显式 artifact 存储、清理策略和 benchmark 归档策略。
- 输出审查：当前探索层已有 Reviewer 终审；未来可以把终审结果更完整地暴露到输出层和 benchmark trace。

## 设计原则

当前实现遵循以下原则：

- 只使用 LangChain 的基础能力，包括模型抽象、工具绑定和结构化输出，避免依赖更高层黑盒智能体框架。
- 系统边界使用 Pydantic schema，保证跨层数据结构清晰可验证。
- 输入、执行、探索和输出层解耦，方便单元测试和替换实现。
- 简单任务优先快速完成，复杂任务通过预算机制获得更充分的探索空间。
- 代码执行能力面向 Notebook 工作流重新抽象，不复用 baseline 的通用沙箱作为数据分析核心执行接口。
