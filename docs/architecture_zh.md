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

当前实现采用混合预算策略：简单任务会分配较小探索预算，复杂任务会获得更多轮次、代码单元和调试次数。

## 任务分流

顶层分流逻辑位于 `src/statigent/agents/data_science.py`。

`StatigentDataScienceAgent` 实现 benchmark 侧需要的 `DataScienceAgent` 协议：

- `run_analysis_for_eval()`：完整运行输入画像、任务书生成、任务分流、数据探索和输出渲染。
- `run_modeling_for_eval()`：当前是数据建模占位实现，返回未支持状态对应的占位提交路径。

任务分流规则如下：

- `data_analysis`：进入数据探索层执行，并由输出层生成最终结果。
- `data_modeling`：当前返回 unsupported。未来会先执行探索层生成结构化 EDA 报告，再更新任务书并交给建模层。
- `deep_analysis`：当前返回 unsupported。该类型为未来商业数据分析报告预留。
- `unknown`：返回 unsupported，避免在任务意图不清时进入高成本流程。

## Notebook Kernel 层

Notebook Kernel 抽象位于 `src/statigent/notebook/`。该层的目标是为数据分析智能体提供接近 Jupyter Notebook 的增量式代码执行体验。

核心接口是 `NotebookKernel`，主要方法包括：

- `start(context)`：启动执行上下文，传入输入路径、工作目录和超时时间。
- `execute_cell(code, purpose)`：执行一个代码单元，并返回 stdout、stderr、退出码、耗时和生成物引用。
- `shutdown()`：释放 kernel 资源。

当前实现包括：

- `DockerNotebookKernel`：真实 Docker 执行实现，用于生产路径。它在多个代码单元之间维护执行状态，使 Coder 可以边写代码边观察结果。
- `FakeNotebookKernel`：测试替身，用于单元测试中验证 orchestration 行为。

这套抽象和早期 `sandbox/DockerSandbox` 分离。`DockerSandbox` 是为 ReAct baseline 提供通用代码执行能力，`NotebookKernel` 则面向数据分析工作流，强调增量执行、artifact 管理和后续可定制性。

## 数据探索层

数据探索层位于 `src/statigent/exploration/`，当前采用四角色多智能体骨架：

- `Inspector`：读取任务书和数据画像，提出下一步探索动作。
- `Reviewer`：审查探索动作的合理性、必要性和风险。
- `Coder`：把通过审查的探索动作转化为可执行 Python 代码。
- `Debugger`：当代码执行失败时，根据错误信息和上下文生成修复代码。

探索动作由 `ExplorationActionKind` 预定义，覆盖 schema 检查、缺失值分析、数值摘要、类别摘要、时间趋势、分组对比、相关性、异常值、数据质量校验、可视化、具体问题回答等标准 DEA 动作。同时保留 `custom_analysis`，允许 Inspector 发起自由探索。自由探索动作必须提供 `rationale`、`expected_evidence` 和 `risk_notes`，避免无约束扩散。

`ExplorationOrchestrator` 负责把四个角色和 Notebook Kernel 串起来。当前版本是架构骨架优先，已经具备：

- 结构化探索动作生成。
- Reviewer 前置审查。
- Coder 代码生成与 notebook cell 执行。
- Debugger 按预算修复失败代码。
- `ExplorationReport` 汇总洞察、证据、artifact 和执行日志。

后续可以在该 orchestrator 上扩展多轮规划、动作队列、探索停止条件、最终报告审查和更细粒度的预算控制。

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
- 输出审查：在最终答案生成后增加 Reviewer 的终审步骤，检查证据是否支撑结论、是否遗漏关键用户需求。

## 设计原则

当前实现遵循以下原则：

- 只使用 LangChain 的基础能力，包括模型抽象、工具绑定和结构化输出，避免依赖更高层黑盒智能体框架。
- 系统边界使用 Pydantic schema，保证跨层数据结构清晰可验证。
- 输入、执行、探索和输出层解耦，方便单元测试和替换实现。
- 简单任务优先快速完成，复杂任务通过预算机制获得更充分的探索空间。
- 代码执行能力面向 Notebook 工作流重新抽象，不复用 baseline 的通用沙箱作为数据分析核心执行接口。
