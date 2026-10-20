# Tasks

## 1. 脚手架与运行时验证

- [x] 1.1 在根 `package.json` 加入锁定版本的 `next`、`react`、`react-dom`、`@types/react`、`@types/react-dom`、`react-markdown`、`remark-gfm`，并新增 `workbench`（`bun --bun next dev web -H 127.0.0.1 -p ${WORKBENCH_PORT:-3100}`）、`workbench:build`、`workbench:start` 脚本；验证 `bun install` 成功且 `bun.lock` 更新
- [x] 1.2 创建 `web/`（`next.config.ts` 设置仓库根为追踪/打包根、`tsconfig.json` 继承根配置、最小 `app/layout.tsx` 与 `app/page.tsx`），更新根 `tsconfig.json`/`biome.json` 纳入 `web/**`；验证 `bun run lint`、`bun run typecheck` 通过
- [x] 1.3 最小可行验证：一个 `app/api/health/route.ts` 导入 `src/models/config` 的 `selectProfile` 与 `src/records/store` 的 `readManifest`，在 `bun run workbench` 下返回 200；若 Bun 运行时不可行，按 design D2 退回 Node 并在 design.md 记录结论；验证 `curl http://127.0.0.1:3100/api/health` 成功

## 2. 本机访问与模型配置

- [x] 2.1 实现 `src/workbench/access.ts`（Host 白名单、非 GET 请求同源 Origin 校验）与 `web/proxy.ts`（Next 16 的 Middleware 新名称）；验证单元测试覆盖合法回环 Host、外部 Host、跨站 Origin 被拒
- [x] 2.2 实现模型列表服务与 `GET /api/models`，只返回 `id`、`display_name`、`capabilities`、`key_present`；验证单元测试断言响应中不含密钥值与 `api_key_env` 以外的环境内容

## 3. 输入区

- [x] 3.1 实现 `src/workbench/inputs.ts`：输入区位于 `runs/workbench/inputs/`，上传校验单层文件名、扩展名白名单（csv/tsv/xlsx/json/parquet）、大小上限（默认 100 MiB，可由环境变量调整）、同名冲突失败，记录大小与 sha256，列出与删除仅限常规文件；验证单元测试覆盖 `..`、分隔符、隐藏前缀、符号链接、超限与冲突
- [x] 3.2 实现 `POST/GET /api/inputs` 与 `DELETE /api/inputs/[name]`（流式写入临时文件后原子改名；`/api/inputs` 不经 Proxy，处理函数自行调用 `rejectNonLocal`，并核对实际接收字节数）；验证用 `curl` 上传 `tests/fixtures/synthetic.csv` 后列表可见，非法名称返回 4xx

## 4. 任务组装与前置检查

- [x] 4.1 实现 `src/workbench/agents.ts` 注册表与 EDA 的 Zod 载荷 Schema、`buildTask`（固定输入根、按后端选镜像、默认种子、报告限制），最终调用 `validateTask` 与 `preflightInputs`；验证单元测试覆盖合法任务、空目标、负预算、未知 profile、未注册智能体类型、输入区外文件
- [x] 4.2 实现前置检查：所选 profile 的密钥环境变量存在、`docker image inspect <image>` 成功；验证单元测试以可注入的命令执行器模拟 Docker 不可用与镜像缺失并返回具体缺失项

## 5. 运行托管

- [x] 5.1 实现 `src/workbench/worker.ts`：解析参数、以预分配 run ID 调用 `runAgent`、信号接入 `AbortController`、结束输出结果摘要并按状态设置退出码；验证 `tests/integration` 中以替身模型客户端运行一次合成任务的路径可行，或在无法替身时用 `--help`/参数校验测试覆盖入口
- [x] 5.2 实现 `src/workbench/supervisor.ts`：`globalThis` 单例、环境变量白名单、旁路记录 `runs/workbench/supervisor/<run_id>.json`（任务快照、pid、退出码、stderr 尾部）、并发上限、看门狗、取消（SIGTERM → 宽限 → SIGKILL）、Web 服务退出时转发 SIGTERM；验证集成测试用可控替身 worker 覆盖正常结束、取消、拒绝退出被强杀、崩溃、并发超限
- [x] 5.3 实现 `src/workbench/runs.ts` 显示状态判定（design D4 表格）与运行列表（倒序、损坏目录作为错误项、只扫描 `runs/workbench/runs/`）；验证单元测试逐行覆盖判定表与损坏清单
- [x] 5.4 实现 `POST /api/runs`（校验 → 前置检查 → 启动 → 返回 run ID）、`GET /api/runs`、`GET /api/runs/[id]`、`POST /api/runs/[id]/cancel`；验证集成测试在替身 worker 下经路由处理器完成提交、查询、取消

## 6. 实时轨迹

- [x] 6.1 实现 `src/workbench/events.ts`：字节偏移增量读取、只切完整行、行号游标、Zod 判别联合规范化已知事件、未知或解析失败降级为 generic、大内容只保留引用；验证单元测试覆盖未完成末行、断点续读、persistent-kernel 与 fresh-script 及 planner-executor 合成轨迹、未知类型
- [x] 6.2 实现 `GET /api/runs/[id]/events` SSE（`Last-Event-ID`/`?after=` 续传、500 ms 轮询、终态读尽后发送 `end`、客户端断开即停止）；验证集成测试在替身 worker 追加事件时依次收到事件、断线后从指定序号续传

## 7. 产物与结果

- [ ] 7.1 实现 `src/workbench/artifacts.ts` 与 `GET /api/runs/[id]/artifacts/[artifactId]`、`GET /api/runs/[id]/files/[name]`（白名单：`analysis.json`、`analysis.md`、manifest 导出项），含 run ID 格式与 `realpath` 边界、`readArtifact` 完整性校验、按内容识别图片类型、`nosniff` 与 CSP 头；验证单元测试覆盖越界 run ID、未登记产物、篡改产物、符号链接、图片与文本类型
- [ ] 7.2 实现结果摘要接口（终态与原因、结论、证据引用、报告图片映射、导出状态、token 与执行次数）；验证单元测试用已完成、预算耗尽、失败三种合成运行断言字段与“不完整”标记

## 8. 前端界面

- [ ] 8.1 实现全局布局、CSS 变量（亮/暗色）与 `/` 页面：输入区面板（上传/列表/删除）、新任务表单（模型、组织、后端、预算、报告开关、前置检查错误展示）、最近运行；验证 `bun run workbench` 下手动上传并提交表单校验错误能逐字段显示
- [ ] 8.2 实现 `/runs/[id]` 页面：状态条与取消按钮、`EventSource` 驱动的轨迹时间线（规划者/子任务分组、单智能体不出现空规划者组、代码单元与输出折叠、按需拉取模型内容）、实时预算侧栏；验证用一个已存在的合成或历史运行目录打开页面，轨迹与预算正确显示，断网重连不重复事件
- [ ] 8.3 实现“结果”与“文件”标签：`react-markdown` 安全渲染（无原始 HTML、图片只映射到已登记产物、外链 `rel="noreferrer"`）、证据引用、Notebook/脚本与 analysis.json 下载、不完整运行的提示；验证用含远程图片与 `<script>` 的合成报告确认不加载、不执行
- [ ] 8.4 实现 `/runs` 历史运行表（状态、目标摘要、组织、后端、模型、成本、错误项）；验证页面列出合成运行目录且损坏项不影响其他行

## 9. 文档与端到端验证

- [ ] 9.1 编写 `docs/workbench.md`（前提：Docker 镜像构建命令、密钥环境变量；启动命令与端口；目录布局；安全边界；孤儿进程手动处理；工作台运行不作为正式实验结果），并在 `docs/agent.md` 链接；验证文档中的启动命令可按原文运行
- [ ] 9.2 实现显式冒烟入口 `bun run test:smoke:workbench --model <id>`（启动服务、上传 `tests/fixtures/synthetic.csv`、提交小预算 planner-executor 报告任务、订阅事件至终态、校验结果接口与报告图片可读）；验证在有密钥与镜像的本机上实际运行一次并记录 run ID 与结果
- [ ] 9.3 运行 `bun run check` 与 `bun run test:integration`，确认默认检查在未设置任何模型密钥时通过；如实记录未运行或失败的检查

## Workflow follow-up

- 通过自审与相关检查后，按项目约定以 `git merge --no-ff` 合并 `feat/workbench` 到 `main`。
- 同步 delta spec 到 `openspec/specs/agent-workbench/` 并归档变更。
