# Spec Delta

## ADDED Requirements

### Requirement: 视觉能力声明与图像输入

模型配置 SHALL 可声明视觉能力，未声明时视为不支持。仅声明视觉能力的配置可以发送包含文本与图像片段的用户消息；首版图像片段只支持 chat-completions 协议的 base64 data URL 形式。图像 MUST 只出现在用户消息中，格式依据文件内容识别，单张大小、张数、像素尺寸和请求总大小 MUST 在发送前校验。

#### Scenario: Image request to a vision profile
- **WHEN** 调用方向声明视觉能力的 DeepSeek 配置发送一段文本和两张 PNG
- **THEN** 请求按 `image_url` data URL 片段发送，用量与模型身份照常记录

#### Scenario: Image request to a text-only profile
- **WHEN** 调用方向未声明视觉能力的配置发送图像片段
- **THEN** 请求在发出前被拒绝并给出能力错误

#### Scenario: Invalid image part
- **WHEN** 图像出现在系统消息中，或内容不是允许的图片格式，或超过尺寸与大小上限
- **THEN** 请求在发出前被拒绝，不依赖服务端返回错误

#### Scenario: Remote image URL
- **WHEN** 调用方试图以外部 http(s) 地址提供图像
- **THEN** 请求被拒绝，系统不让模型服务代为下载任意外部地址

### Requirement: 无工具的单轮模型调用

系统 SHALL 支持不附带工具定义的模型请求，供评分等非智能体场景使用，并沿用相同的凭据隔离、时限、大小上限、失败分类和用量记录。此类调用的大小上限 MUST 可独立于智能体调用配置。返回工具调用或被截断的响应 MUST 作为失败而非有效输出。

#### Scenario: Judge request without tools
- **WHEN** 评分端以无工具方式请求模型并收到正常文本回复
- **THEN** 系统返回文本、模型身份与用量，不要求任何工具调用字段

#### Scenario: Truncated judge response
- **WHEN** 无工具请求因输出上限结束
- **THEN** 系统将其标为截断失败并保留已知用量
