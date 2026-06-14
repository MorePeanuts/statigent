# Statigent 代码执行效率与错误率分析

本文记录 Statigent 与 baseline 智能体在代码执行效率和代码执行错误率方面
的评测发现，供后续架构迭代、实验设计和论文写作参考。

## 统计口径

### 代码总行数

`total_code_lines` 表示智能体实际提交给执行环境的代码行数总和：

- 排除空行；
- 排除首个非空白字符为 `#` 的纯注释行；
- 保留带有行尾注释的可执行代码行；
- 重复执行、失败执行和修正执行均应分别计入。

各智能体的代码载荷来源不同：

- Statigent：`append_code_cell` 中的代码，以及
  `debug_cell.metadata.corrected_code` 中实际执行的 Debugger 修正代码；
- Datawise：assistant 消息中的每个 Python fenced block；
- Data Interpreter：`write_code` 和 `reflect_code` 中实际执行的 Python
  fenced block；
- ReAct：每个 `python` 或 `bash` tool call。

### 代码执行错误率

代码执行错误率定义为：

```text
错误代码块数量 / 总代码块数量
```

错误由执行环境的明确失败信号判定，例如非零退出码或
`execute_code.metadata.success == false`。未执行的自然语言响应不计入代码块。

## DABench 实测结果

以下运行均使用 `ds4-flash` 模型，并包含 257 个 DABench 任务：

| 智能体 | 评测目录 | 代码总行数 | 代码执行错误率 |
|---|---|---:|---:|
| Statigent | `dabench-statigent-ds4-flash-20260604T235511` | 4,263 | 0.82% |
| Data Interpreter | `dabench-data_interpreter-ds4-flash-20260602T182230` | 8,816 | 7.48% |
| ReAct | `dabench-react-ds4-flash-20260524T233933` | 9,586 | 7.21% |
| Datawise | `dabench-datawise-ds4-flash-20260602T180736` | 16,796 | 50.47% |

Statigent 使用的执行代码总量约为：

- Data Interpreter 的 48%；
- ReAct 的 44%；
- Datawise 的 25%。

## 为什么不使用平均代码块长度作为核心指标

平均代码块长度不能稳定证明 Statigent 优于所有 baseline。按每次实际执行的
代码载荷统计，当前 DABench 样本的近似结果为：

| 智能体 | 平均有效代码行数/块 |
|---|---:|
| Data Interpreter | 8.04 |
| Datawise | 9.87 |
| Statigent | 11.62 |
| ReAct | 15.71 |

Statigent 的代码块明显短于 ReAct，但长于 Data Interpreter 和 Datawise。
不同架构对代码块边界和状态持久化的选择会显著影响该指标，因此不应使用它来
主张 Statigent 的整体执行效率。

代码总行数更直接地衡量完成同一任务集合所生成和执行的代码量，也更适合作为
增量执行架构的核心效率指标。

## Statigent 低代码执行错误率的关键设计

### 证据驱动的窄步骤规划

Inspector 根据当前证据决定下一步需要回答的问题，并给 Coder 下发范围明确的
执行指令。Coder 不需要在一次执行中完成读取、清洗、建模和最终输出，从而降低
单次执行的依赖数量和逻辑复杂度。

### Inspector 与 Coder 职责分离

Inspector 决定需要获得什么证据，Coder 负责用代码获得该证据。这种职责分离
限制了 Coder 自行扩张任务范围，减少未经验证的假设进入执行代码。

### 持久化 notebook 状态

Statigent 的代码块运行在连续的 notebook 内核中，可以复用已加载的数据和中间
变量。相比之下，Datawise 和 ReAct 的执行进程不持久化状态，trace 中经常出现
因模型错误假设变量仍然存在而产生的 `NameError`。

Datawise 约 50% 的代码执行错误率与这种状态模型不匹配高度相关。

### 结构化代码提交

Coder 必须通过 `append_code_cell` 工具提交代码。执行器不需要从自然语言或
Markdown 中猜测待执行内容，减少了代码提取和协议解释的不确定性。

### 执行结果立即进入下一步决策

每次执行结果都会立即反馈给 Inspector 和 Coder。后续步骤基于真实 observation
规划，而不是继续依赖模型对执行结果的猜测。

### 独立的 Debugger 修复路径

执行失败后，Statigent 将失败代码、异常和上下文交给专门的 Debugger，并通过
替换同一 notebook cell 验证修正结果。错误状态不会直接流入后续探索步骤。

## 与 Baseline 的主要差异

### Datawise

- 一条 assistant 消息可以产生多个 Python 代码块；
- 每次代码执行使用独立进程，但模型经常假设变量状态持续存在；
- 大量错误来自 `df`、模型或中间变量未定义。

### ReAct

- 工具使用自由度高，缺少 Inspector 提供的执行前步骤约束；
- 单次 Python 或 Bash 调用通常承担更大范围的工作；
- 失败代码的影响范围更大。

### Data Interpreter

- 已具有分步执行、连续状态和失败反思，因此错误率明显低于 Datawise；
- 主要由预先计划驱动，缺少 Inspector 根据实时证据持续调整下一步的控制；
- 错误率仍约为 Statigent 的九倍。

## 可支持的结论

根据当前评测结果，可以支持以下表述：

> Statigent 通过证据驱动的分步规划、持久化执行状态、结构化代码提交和独立
> Debugger 修复路径，在完成相同 DABench 任务集合时执行了显著更少的代码，
> 同时代码执行错误率明显低于对比 baseline。

不应使用当前结果支持以下表述：

> Statigent 的平均代码块长度远小于所有 baseline。

该表述与 Datawise 和 Data Interpreter 的实测结果不一致。

## 后续事项

- 在新增评测完成后重新运行
  `tools/backfill_code_execution_stats.py evaluations`；
- 引用指标时同时记录评测目录、模型、任务数和统计脚本版本，避免不同运行之间
  的口径混用。
