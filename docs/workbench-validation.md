# 工作台验收记录

记录 [workbench.md](workbench.md) 所述工作台在本机的实际检查结果。环境：macOS（Apple Silicon），Bun 1.4.2，Next.js 16.4.2，Docker 镜像 `statigent-runtime:dev`（`sha256:9b511502…`，`linux/arm64`）。

## 默认检查（无模型密钥）

在显式去掉 `DEEPSEEK_API_KEY` 的环境中运行 `bun run check`：Biome、两层类型检查（`src`/`tests` 与 `web`）、TypeScript 快速测试 461 项与 Python 测试 253 项全部通过。工作台单元测试覆盖访问校验、模型列表脱敏、输入区、任务组装、前置检查、worker 入口、状态判定、事件读取与规范化、产物访问、结果摘要。

工作台集成测试（`tests/integration/workbench-*.test.ts`，19 项）用替身 worker 在子进程中运行真实的智能体循环，不调用模型或 Docker。首次在全量集成套件中运行时，看门狗用例因 worker 启动超过 100 ms 而未走到强制结束分支（测试时间窗过紧，监督器行为本身正确）；放宽为先等 worker 就绪、2 秒后触发看门狗后，在全量套件并发负载下连续三次 19/19 通过（提交 29d5246）。

## 经 Next 服务的实测

- **访问边界**：外部或 DNS rebinding 形式的 `Host`、跨站或缺失 `Origin` 的写请求均返回 403；同源请求通过。
- **上传**：发现 Next 16 的 Proxy 会把请求体缓冲到 10 MB 并截断，因此上传接口不经 Proxy、自行做相同检查。16 MB 文件上传后服务端 sha256 与本地一致；超限 413、重名 409、非法名称 400。
- **事件流**：用一次真实的规划—执行运行记录（330 个事件）经 SSE 读取，序号连续，`Last-Event-ID: 325` 从 326 续传，响应未被压缩缓冲。
- **产物与文件**：PNG 按内容返回 `image/png`，pickle 以原文件名作附件下载，`manifest.json` 等未列出文件与含 `..` 的路径（`curl --path-as-is`）均为 404。
- **生产构建**：`bun run workbench:build` 无警告；文档中的 `bun run workbench`、`WORKBENCH_PORT=3200 bun run workbench`、`workbench:build` + `workbench:start` 均按原文启动并响应。

## 浏览器人工核对

在应用内浏览器中检查（1440×900）：

- 首页：上传的文件可列出、勾选、删除；空目标与负数预算的错误显示在对应字段旁；无密钥时提交得到前置检查提示。
- 运行详情：规划—执行运行中执行者工作归入子任务，单智能体运行没有空的规划者分组；代码单元合并代码、输出预览与图表；模型输出按需加载；证据“执行 N”跳回并高亮对应单元。
- 实时与取消（替身 worker）：状态从“启动中”实时更新，提示“等待规划者模型响应…”；点击取消后显示“已取消”，取消按钮消失。
- 报告安全：合成报告中的 `<script>` 与 `onerror` 未执行，原始 HTML 被丢弃，远程图片显示为“未登记，已忽略”，`javascript:` 链接未渲染为链接，外链带 `noreferrer noopener`，页面无任何外部请求。
- 运行历史：按时间倒序列出，损坏的记录单独列为错误项。

未覆盖：浏览器侧真实网络中断后的自动重连（服务端续传由集成测试覆盖，页面按序号去重）；系统文件选择框与拖放上传（上传接口经 curl 验证）。

## 真实冒烟

```bash
bun run test:smoke:workbench -- --model deepseek-flash
```

| 项目 | 结果 |
|---|---|
| run_id | `b0962231-2df7-4914-a6a8-647114d20088` |
| 代码版本 | `29d5246`，工作区无未提交改动 |
| 任务 | `configs/tasks/collaboration-report.json`（规划—执行、持久内核、要求报告） |
| 模型 | deepseek-flash（返回模型身份一致） |
| 终态 | completed（analysis_accepted），2 次委派 |
| 用量 | 13 次模型调用，8 次代码执行，103,028 token（输入 87,885 / 输出 15,143），墙钟 76.6 秒 |
| 检查 | 14/14 通过：运行完成、128 个事件按序无缺口、结论被接受、分组均值 A=2/B=4、证据全部可解析、报告可读、2 张报告图片以 `image/png` 返回、Notebook 已导出且可下载 |

结果文件：`runs/workbench/smoke/b0962231-2df7-4914-a6a8-647114d20088.json`（本地，不提交）。只运行一次，未重试。

## 全量集成测试

`bun run test:integration`（不设置模型密钥，真实 Docker）：TypeScript 部分 39 个文件 139 项中 138 项通过，耗时约 58 分钟；唯一失败是上文的看门狗用例，该次套件在修复提交之前启动，修复后的用例已在并发负载下单独连续通过三次。由于脚本以 `&&` 串联，bun 部分失败后 Python 部分未自动执行，随后单独运行 `uv run pytest -m integration tests/python`：6 项全部通过。修复后未重新运行完整的 58 分钟套件。
