# 新脚本后端验收记录

日期：2026-10-13。变更：`add-fresh-script-backend`，任务分支 `feat/fresh-script-backend`。本记录分开说明软件行为、无模型验收及研究实验，不将合成测试当作方法收益。

2026-10-14 补充：single 与 planner-executor 的真实模型脚本冒烟均已有验收和独立重放通过证据。首次验收器误判、双角色输出契约失败、一次真实复测及全部成本分别保留，见 [两章消融路径验收](ablation-readiness-validation.md)。下文“未运行”描述原变更归档时的历史状态；四组基准开发预实验仍未执行。

## 环境与范围

Bun 1.4.2；Python 3.12.9、uv 0.8.22 及计算依赖按锁文件构建。Docker Engine 29.4.0，容器平台 linux/arm64。本次镜像 `statigent-runtime:fresh-script` 的实际 ID 为 `sha256:2207a52ae443611662287f3152f3b5bd55d82c3b4f9b021638d16c531e06ccb9`，本机构建无 RepoDigest。原 `statigent-runtime:dev` 未覆盖，供原镜像持久重放回归。

执行、记录/重放和 EDA/评测分别按阶段提交。宿主运行记录位于忽略的 `runs/`，不入库。本地耗时只用于检查记账字段，不作为服务器性能结论。

## 软件与无模型证据

- 新脚本 wire v2 及严格身份校验；默认配置和旧 wire v1 保留。镜像能力不符在首次模型调用前失败。
- 实际 Python PID 与脚本 `os.getpid()` 核对；每次独立进程，变量/环境修改不延续、种子每轮重置；文件显式复用，异常前部分文件保留。
- 7 项 Docker 运行器专项通过：静态表格/PNG、PNG/JPEG 文件、普通脚本末尾表达式、EOF 输入、伪造 stdout JSON、洪泛/累计额度、非法/超限产物、跨会话与网络隔离、超时/取消、提前退出、正常和脱离进程组的后代清理。
- 单角色及双角色可控模型 Docker 测试通过：保存 CSV → 后续新进程读取 → 图表报告；双角色跨委派文件复用，规划者不接收完整代码/调试历史。报告来源与图片绑定有效，脚本源码与同名文件快照独立保存。
- 独立脚本重放通过，原目录全文件 SHA-256 不变；缺失中间文件只能由前序脚本重建，原文件不挂载。源码、输入、镜像元信息不匹配被拒绝；含修复前错误的轨迹为 unsupported。额外用合成成功记录验证：重放读取缺失文件时实际失败，即使原产物中保存同名文件也不补取，源目录哈希保持不变。
- v1/v2/v3 无模型、单角色及双角色只读检查和外部导出通过，源目录全文件哈希不变。旧镜像持久重放及建模嵌套 EDA 的完整集成验收也已通过；旧镜像重放核对源目录全文件哈希不变。
- 持久提示字节已对照变更前源码核对，并冻结 SHA-256 回归断言：single `e803e08c8e1eceeada50f4a2c722a80ea1070de9f682a6620f3ac697f4b1be52`；planner `e77ad01f710b53c7d42f5d64a909cc54dccf68515c8c98ef03bc2c13cd1df381`；executor `618ba28c706c109788dd6614d20ff8ed1de24ce47e9921d6f34456e0edc7ee84`。

无模型 CLI 示例运行 `2db3c2d6-78f4-4fc9-8f71-51e8aeb5d637`：两次脚本执行、保存并重新读取 means.csv、断言 A=2/B=4、导出 means.png。记录墙钟约 4486 ms、容器启动约 626 ms、尝试累计约 3727 ms；其中进程初始化约 1527 ms、用户代码约 1986 ms、收集与回收阶段分别约 0.63/0.65 ms，未知阶段数为 0。尝试还包括通道调度等开销；阶段小计不要求机械相加等于尝试墙钟，不能再次计入总墙钟。模型用量为 not_applicable。角色/子任务 token 小计是同一任务总消费的视图，不重复计费。

验收结束后 `docker ps -a --filter label=org.statigent.runtime=1` 返回空，未发现运行容器残留。文档中的 runtime inspect/export/replay 已用成功脚本示例实际核对，重放状态为 passed；含原始错误的合成轨迹保持 unsupported。

## 开发计划与冒烟

| 本地只读计划 | 任务 × 组 × 重复 | 单元数 | 状态 |
| --- | --- | --- | --- |
| InfiAgent development-selection | 12 × 4 × 1 | 48 | 预览通过 |
| DSBench-Analysis development-selection | 6 × 4 × 1 | 24 | 预览通过 |
| DAComp-DA development-selection | 6 × 4 × 1 | 24 | 预览通过 |

四组同模型、同镜像、同基准内逐题预算一致；整批执行及评委预算覆盖全部声明单元。计划分别保存的哈希为 `e466a78156f2be58d662d2b7570108e81e3aa8cef67889f829447550d8dbd699`、`fbcfbbca6f12652af6241a4de55bec193dad1751e911abc4325703c276cd7e0f`、`e34d3605353029821e87a6f0ba493eb38dbf9482a9f62b15c578f420a3e0a21b`。旧开发配置未改动。

`single` 和 `planner-executor` 的 `test:smoke:script --preflight` 均通过，确认上述镜像；模型请求数均为 0。固定任务配置为 `configs/tasks/fresh-script-report.json`，真实执行入口只运行显式选择的一组，首次失败保留且不自动加跑。

## 检查与实验状态

| 层次 | 实际状态 |
| --- | --- |
| 软件接入 | 已实现，两后端共用 EDA/评测主循环 |
| 快速检查 | `bun run check` 已通过：238 项 TypeScript、54 项 Python（25 项按标记未纳入快速检查） |
| 后端 Docker 专项 | 7 项运行器测试已通过；单/双角色脚本报告及重放通过 |
| 全套集成回归 | `STATIGENT_TEST_IMAGE=statigent-runtime:fresh-script bun run test:integration` 通过：45 项 TypeScript、6 项 Python；随后新增缺失文件重放专项 1 项通过 |
| 真实模型脚本冒烟 | 未运行；只执行两组无模型 preflight |
| 四组开发预实验 | 未运行；只完成配置和只读计划预览 |
| 正式论文实验 | 未运行，需另行冻结任务、预算、重复、指标与排除规则 |

允许文件复用、脚本输出语法和每轮随机初始化是对照条件的一部分。当前没有测量方法收益或因果归因，没有将缓存/历史产物报告为本次免费计算。任务内存与文件访问安全边界是 Docker 容器；uv 子进程及 bridge 本身不是额外安全隔离层。

实现阶段的 `openspec validate add-fresh-script-backend --strict` 通过；实现及验收未调用付费模型。随后已同步主规格并通过 `openspec validate --specs --strict`，完整规划与任务记录见[变更归档](../openspec/changes/archive/2026-10-13-add-fresh-script-backend/)。
