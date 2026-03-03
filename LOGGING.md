# 日志功能说明

## 概述

已为 Clare Workers 代理添加完整的请求日志功能，所有 API 请求的详细信息都会在 Cloudflare Observability 中展示。

## 日志类型

### 1. 请求开始日志 `📥 [REQUEST_START]`

记录每个请求的完整信息：
- `requestId`: 唯一请求 ID
- `timestamp`: 时间戳
- `method`: HTTP 方法
- `url`: 请求 URL
- `headers`: 请求头（完整）
- `body`: 请求体（OpenAI 格式）
- `apiKeyPrefix`: API Key 前缀（脱敏）

### 2. 上游请求日志 `📤 [UPSTREAM_REQUEST]`

记录发送到上游 API 的请求：
- `requestId`: 请求 ID
- `url`: 上游 API URL
- `headers`: 请求头（API Key 脱敏）
- `body`: 转换后的请求体

### 3. 上游响应日志 `📨 [UPSTREAM_RESPONSE]`

记录上游 API 的响应：
- `requestId`: 请求 ID
- `status`: HTTP 状态码
- `statusText`: 状态文本
- `headers`: 响应头

### 4. 请求完成日志 `✅ [REQUEST_COMPLETE]`

记录请求成功完成：
- `requestId`: 请求 ID
- `duration`: 请求耗时（毫秒）
- `response`: 最终响应体

### 5. 流式响应日志

- `🌊 [STREAM_START]`: 流式响应开始
- `🌊 [STREAM_COMPLETE]`: 流式响应完成（含耗时）

### 6. 错误日志 `❌ [ERROR]`

记录所有错误：
- `requestId`: 请求 ID
- `duration`: 错误发生时的耗时
- `error`: 错误信息（含堆栈）- `context`: 额外上下文信息

### 7. 模型映射日志 `🔄 [MODEL_MAPPING]`

记录模型名称映射：
```
🔄 [MODEL_MAPPING] gpt-4 -> claude-opus-4-5-20251101
```

### 8. 模式日志 `🔄 [MODE]`

记录代理模式：
- `Anthropic mode`: 转换模式
- `Passthrough mode`: 透传模式

## 在 Cloudflare Observability 中查看日志

### 1. 实时日志（Tail）

```bash
# 本地开发
npx wrangler dev --local

# 生产环境实时日志
npx wrangler tail
```

### 2. Cloudflare Dashboard

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 Workers & Pages
3. 选择你的 Worker
4. 点击 "Logs" 标签
5. 选择 "Real-time Logs" 或 "Logpush"

### 3. 日志查询

在 Cloudflare Logs 中可以按以下字段过滤：
- `reId`: 追踪单个请求的完整生命周期
- `level`: ERROR / INFO / WARN
- `message`: 日志类型（REQUEST_START / UPSTREAM_REQUEST 等）

## 日志示例

### 完整请求流程

```json
// 1. 请求开始
📥 [REQUEST_START] {
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-03T02:00:00.000Z",
  "method": "POST",
  "url": "https://your-worker.ws.dev/v1/chat/completions",
  "headers": { ... },
  "body": {
    "model": "gpt-4",
    "messages": [...]
  },
  "apiKeyPrefix": "sk-ant-a..."
}

// 2. 模型映射
🔄 [MODEL_MAPPING] gpt-4 -> claude-opus-4-5-20251101

// 3. 模式选择
🔄 [MODE] Anthropic mode

// 4. 上游请求
📤 [UPSTREAM_REQUEST] {
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://api.anthropic.com/v1/messages",
  "headers": { ... },
  "body": { ... }
}

// 5. 上游响应
📨 [UPSTREAM_RESPONSE] {
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "status": 200,
  "statusText": "OK",
  "headers": { ... }
}

// 6. 请求完成
✅ [REQUEST_COMPLETE] {
  "requestId": "550e8b-41d4-a716-446655440000",
  "duration": 1234,
  "response": { ... }
}
```

### 错误示例

```json
❌ [ERROR] {
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "duration": 567,
  "error": {
    "message": "Upstream error: ...",
    "stack": "..."
  },
  "context": {
    "status": 429
  }
}
```

## 性能影响

- 日志记录使用 `console.log` 和 `console.error`，由 Cloudflare Workers 运行时优化
- 敏感信息（API Key）已脱敏，仅显示前 8-12 个字符
- JSON 格式化（`JSON.stringify(data, null, 2)`）仅在开发环境影响性能，生产环境可移除格式化

## 隐私与安全

- ✅ API Key 自动脱敏
- ✅ 完整请求/响应体记录（便于调试）
- ⚠️ 如需符合 GDPR/隐私法规，可在 `logger.ts` 中添加 PII 过滤逻辑

## 自定义日志

修改 `src/logger.ts` 可自定义日志格式和内容：

```typescript
// 示例：添加自定义日志
export function logCustomEvent(requestId: string, eventName: string, data: any) {
  console.log(`🔔 [CUSTOM]`, JSON.stringify({
    requestId,
    timestamp: new Date().toISOString(),
    event: eventName,
    data,
  }, null, 2));
}
```

## 故障排查

### 问题：日志未显示

1. 检查 Cloudflare Dashboard 中的 Logs 设置
2. 确认 Worker 已部署最新版本
3. 使用 `wrangler tail` 查看实时日志

### 问题：日志过多

可以在 `logger.ts` 中添加日志级别控制：

```typescript
const LOG_LEVEL = env.LOG_LEVEL || 'INFO'; // DEBUG / INFO / WARN / ERROR

if (LOG_LEVEL === 'ERROR') {
  // 仅记录错误
}
```

## 相关文件

- `src/logger.ts`: 日志工具模块
- `src/index.ts`: 主逻辑（已集成日志调用）
- `.dev.vars`: 本地开发环境变量
- `wrangler.toml`: Cloudflare Workers 配置
