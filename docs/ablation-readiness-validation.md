# 两章预实验前的消融路径验收

2026-10-14，用户要求先完成第一章新脚本后端真实模型冒烟，再补齐第二章未覆盖的消融矩阵。此轮为工程路径验收，不是正式预实验或效果比较；首次失败保留，修复复测使用新身份，不按外层成绩换题。

## 冻结范围与资源

- 第一章：`configs/tasks/fresh-script-report.json`，single / planner-executor 各一次，deepseek-flash、seed=42、fresh-script 后端。每组 20 次模型尝试、10 次代码执行、400,000 token、600 秒；合计 40 次尝试、800,000 token、1,200 秒。固定合成数据验证独立进程、中间 CSV 跨脚本复用、双角色跨委派复用、带图报告及已知用量；另尝试零 LLM 的独立脚本重放，重放资格与任务完成分别报告。
- 第二章：沿用 `modeling-development` 中 7 个 DSBench、3 个 TabArena 代表任务，仅执行 initial_eda / adaptive_eda，共 20 单元。deepseek-flash、seed=17、固定数据和镜像；每项 30 次模型尝试、300,000 token、900 秒，包含子 EDA。保留原配置的两次终局确认、12 次训练总限额和 450 秒收尾预留。合计阈值 600 次模型尝试、6,000,000 token、18,000 秒；评分和独立预测复现另记。
- 本轮只运行已缺少验证的组；此前 no_eda / collaborative 的小额冒烟使用不同预算及确认模式，不能与本轮拼成公平效果对照。adaptive_eda 按需分析，没有 EDA 不等于配置失败；initial_eda 应先成功执行一次初始分析，再进行建模搜索，后续不追加分析。实际方法权限与轨迹另行核对。
- 预检已通过，零模型、零训练：`runs/ablation-readiness-v1/*-preflight.json`。第二章范围见 `configs/evaluations/modeling-ablation-smoke-v1/`，引用既有开发配置，不修改历史 scope。
- 未知用量、记录或清理错误停止当前受预算约束批次；仅对未执行项或有明确修复的失败项准备独立续跑，不覆盖原记录、不无界重试。

## 执行状态

第一章两组及第二章 20 单元待运行。完整数据、模型和轨迹保存在忽略 Git 的 `runs/`；实际运行身份、代码版本、已测用量、失败和复现结果将在执行后追加。
