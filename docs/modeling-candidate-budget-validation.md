# 候选状态与 EDA 预算控制开发验收

对应变更：`add-modeling-candidate-budget-control`。本记录为功能验收，不是论文正式实验或候选策略收益结论。

## 已完成的工程验证

实现提交 `c1de029`。建模提示词为 `modeling-v2`，接受事件协议 2，候选扩展版本 1；数据准备、评估协议及运行镜像未变。

- `bun run check` 通过：187 个 TypeScript 测试、1,218 个断言；34 个 Python 测试。包含格式/lint、类型检查。
- 全量 `bun run test:integration` 通过：27 个 TypeScript 集成测试、301 个断言（300.31 秒）；6 个 Python 集成测试（11.95 秒）。覆盖共享截止时间改动影响的现有 EDA、执行环境、记录及评测链路。
- 专项真实 Docker 测试通过：2 个测试、86 个断言，114.47 秒。完整链路包含初始训练、双角色 EDA、证据更新、可控代码失败、同候选显式修复、最佳交付、预测复现、重新拟合复现和独立评分；原运行哈希与容器清理检查通过。
- 两次 EDA 的 token 申请分别为 100,000 与 500,000；实际分别 100,000 与 299,895。第二次执行申请 3 次、剩余仅 1 次，因此实际为 1。每次双角色实际各用 30 token，总任务实际 195 token、2 次 EDA 执行，分配量未计作消费。
- 真实 Docker 合成产物额外通过新冒烟验收器，按实验 ID 识别成功修复，未将同候选首次失败误认为最终结果。
- `openspec validate add-modeling-candidate-budget-control --strict` 通过；文档两个 JSON 示例经新协议解析通过，确定性预算示例由单测核对。
- 上一轮真实记录 `9d882127-8732-4f29-92b6-75c1fbb4c4c5` 的 inspect 返回 `not_recorded`；其无模型预测复现通过，独立记录为 `runs/modeling-reproductions/6d8ff12e-ca7b-4ead-8938-9e6060a311af`，未迁移旧候选历史。

专项合成父运行：`runs/integration-modeling-loop/a81848c9-84cc-450e-a1b5-420fa2b3ded6/5a670aab-2805-4c57-b4ef-3bc3df23cd1b`。本地测试日志：`/tmp/statigent-candidate-check.log`、`/tmp/statigent-candidate-integration.log`；日志和运行产物均不提交 Git。

## 真实模型验收范围

只执行一次 `bun run test:smoke:modeling`，使用既有冻结的 `playground-series-s3e9` 开发数据、内部划分与 deepseek-flash profile。固定任务补充了显式候选更新及额度申请的验收要求；未按成绩修改数据、模型或预算。

预算保持 900 秒、40 次总模型尝试、600,000 token 停止阈值，3 次搜索拟合和 1 次最终拟合，最终交付预留 180 秒。一次 EDA 最多 300 秒、20 次模型尝试、400,000 token、10 次执行，实际额度按申请和父剩余量裁剪。两角色和所有重试计入父任务；token 允许已派发响应超阈值，仍保留完整真实消费。

真实验收尚未执行。若失败，保留首次报告、不自动增加预算或重复运行；若仅验收器有误，可离线复核同一运行并独立保存结论。
