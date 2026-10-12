# EDA 智能体

当前变更实现单智能体、持久 Docker Python 会话。配置和示例位于 `configs/models.json` 与 `configs/tasks/synthetic-eda.json`。这不是正式 Benchmark 协议或模型能力对比。

## 配置

模型文件是具名 profile 数组；CLI `--model` 优先于任务的 `model_profile`，`--models` 选择整个模型配置文件。任务参数覆盖内置默认值；未知字段、空目标、越界输入、非法预算及不支持的参数组合在调用前失败，不自动降级。

模型必填 `id/provider/protocol/base_url/model/display_name/api_key_env/capabilities/generation`。`model` 是实际请求标识；`display_name` 仅展示。`provider` 支持 `deepseek` 和 `generic`，协议仅 `chat-completions`。通用提供商支持非流式文本和函数工具，不能假设任意兼容接口的全部功能均适用。自定义模型通过新增 profile 选择，无需改智能体。

DeepSeek 示例请求 `deepseek-flash`，展示 DeepSeek-V4.1-Flash；别名不保证底层权重固定。记录请求及返回模型名、时间和可用指纹。`max_output_tokens` 映射 `max_tokens`；`thinking` 映射 `thinking.type`；`reasoning_effort` 原样传递。推理模式显式启停，开启时拒绝 temperature；通用适配器拒绝 DeepSeek 推理参数。默认 enabled/high/4096 是开发预设，未证明实验最优。历史保留 DeepSeek `reasoning_content`，不进入最终报告。

凭据仅由宿主从 `api_key_env` 读取，不写入配置快照、提示词或容器；不提供自由 headers/body 注入。仅接受 HTTPS，无 URL 用户名密码/query/fragment；测试及本地服务可显式 `allow_loopback_http: true` 使用回环 HTTP。禁止自动重定向，不向跳转目标转发授权。输入清单只读挂载为 `/input/<相对路径>`，禁止越界和符号链接；任务输入不会授予新工具权限。

默认预算：模型尝试 12 次（含限流重试）、实际单元 8 次、累计 token 停止阈值 100000、请求 90000 ms、任务 300000 ms、限流重试 2 次、连续代码错误后修复 2 次、全任务动作纠正 2 次、请求 256 KiB、响应 2 MiB、模型轨迹累计 16 MiB。单次输出上限由模型 profile 控制，示例 4096 tokens；其他预算字段见 `DEFAULT_BUDGET`。

## 调用和失败语义

每次 HTTP 尝试单独记账，取消/超时/断流/不明确 5xx 的生成结果和成本标 unknown，不自动重试。仅 429 作为服务拒绝生成的限流响应，在次数与剩余时间内退避重试；401/403/参数/协议错误直接失败。单请求大小和超时为硬限，响应分块计数后才解析，超限片段不能执行。工具 ID、响应角色、结束原因与消息结构必须有效；缺失或重复 ID 不能构造下一轮合法历史，直接停止。

用量保留原始 usage 与归一化字段，实际总量为 prompt_tokens + completion_tokens。缓存命中/未命中是输入子项，推理 token 是输出子项，不重复相加。缺失字段保留 null/unknown；货币成本未计算，不能记为免费。请求体 UTF-8 字节数作为输入估计并与单次输出额度作事前检查，估计不冒充实际 tokenizer 计数，也不是数学上界。真实总量达到阈值后停止，允许记录最后一次调用造成的超出；未知消费停止为 failed/accounting_incomplete。
