# OpenAI to Anthropic Proxy (Cloudflare Workers)

将 OpenAI 格式的请求转换为 Anthropic Claude 格式的轻量级代理服务，部署在 Cloudflare Workers 上，完全免费。

## 功能特性

- ✅ **双模持**：Anthropic 转换模式 + OpenAI 透传模式
- ✅ **完整格式转换**：OpenAI Chat Completions API → Anthropic Messages API（Anthropic 模式）
- ✅ **透传模式**：直接转发 OpenAI 格式请求到任意 OpenAI 兼容接口（Passthrough 模式）
- ✅ **模型名称映射**：支持如 MiniMax-M2 → claude-opus-4-6）
- ✅ **自动缓存优化**：智能在合适位置添加 `cache_control`（1h TTL，仅 Anthropic 模式）
- ✅ **工具调用支持**：完整转换 OpenAI tools → Anthropic tools（Anthropic 模式）
- ✅ **流式响应**：支持 SSE 流式输出
- ✅ **零配置密钥**：API Key 从请求头自动提取，无需预配置
- ✅ **完整日志记录**：所有请求详情在 Cloudflare Observability 中展示
- ✅ **免费部署**：部署在 Cloudflare Workers，每天 100,000 次免费请求

## 快速开始

### 1. 部署到 Cloudflare Workers

#### 方式一：使用 Wrangler CLI（推荐）

```bash
# 克隆项目
git clone <your-repo>
cd cloudflare-proxy

# 安装依赖
npm install

# 登录 Cloudflare
npx wrangler login

# 部署
npm run deploy
```

#### 方式二：手动部署

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 Workers & Pages
3. 创建新的 Worker
4. 复制 `src/index.ts`、`src/converter.ts`、`src/types.ts` 的内容
5. 粘贴到 Worker 编辑器中（需要合并为单文件）
6. 保存并部署

### 2. 配置环境变量

在 Cloudflare Workers 设置中添加环境变量：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PROXY_MODE` | 代理模式：`anthropic`（转换格式）或 `passthrough`（透传） | `anthropic` |
| `ANTHROPIC_BASE_URL` | 目标 API 端点 | `https://api.anthropic.com` |
| `MODEL_MAPPING` | 模型名称映射 | 空（不映射） |
| `MAX_TOKENS_MAPPING` | 每个模型的 max_tokens（可选） | 自动识别模型类型 |
| `MAX_TOKENS` | 全局默认 max_tokens（可选） | 根据模型自动选择 |
| `SESSION_TTL_MINUTES` | Session 轮换周期（分钟，仅 Anthropic 模式） | `60` |

#### Max Tokens 默认值策略

如果不配置 `MAX_TOKENS_MAPPING`，代理会根据模型名称自动选择合理的默认值：

| 模型系列 | 默认 max_tokens |
|---------|----------------|
| Claude Opus 4 | 16384 |
| Claude Opus | 8192 |
| Claude Sonnet | 8192 |
| Claude Haiku | 4096 |
| GPT-4o | 16384 |
| GPT-4 | 8192 |
| GPT-3.5 | 4096 |
| MiniMax / ABAB | 8192 |
| DeepSeek | 8192 |
| Qwen | 8192 |
| QwQ | 32768 |
| Gemini | 8192 |
| GLM-4 | 8192 |
| GLM-3 | 4096 |
| 其他模型 | 8192 |

**注意**：如果请求中已指定 `max_tokens`，则使用请求中的值。

#### 模式说明

**Anthropic 模式（默认）**：
- 将 OpenAI 格式请求转换为 Anthropic Messages API 格式
- 自动添加 Prompt Caching 优化
- 适用于调用 Anthropic Claude API

**Passthrough 模式**：
- 直接转发 OpenAI 格式请求，不做格式转换
- 仅执行模型名称映射
- 适用于调用任意 OpenAI 兼容接口（如 MiniMax、DeepSeek 等）

#### Anthropic 模式配置示例

```bash
# 在 wrangler.toml 中配置
[vars]
PROXY_MODE = "anthropic"
ANTHROPIC_BASE_URL = "https://api.anthropic.com"
MODEL_MAPPING = "gpt-4:claude-opus-4-5-20251101,gpt-3.5-turbo:claude-3-5-haiku-20241022"

# 可选：自定义 max_tokens（不配置则使用默认值）
# MAX_TOKENS_MAPPING = "claude-opus-4-5-20251101:16384,claude-3-5-sonnet-20241022:8192"
```

#### Passthrough 模式配置示例

```bash
# 在 wrangler.toml 中配置
[vars]
PROXY_MODE = "passthrough"
ANTHROPIC_BASE_URL = "https://api.minimax.com"  # 或其他 OpenAI 兼容接口
MODEL_MAPPING = "MiniMax-M2:claude-opus-4-6"

# 可选：自定义 max_tokens（不配置则使用默认值）
# MAX_TOKENS_MAPPING = "claude-opus-4-6:8192"
```

### 3. 使用代理

部署完成后，你会获得一个 Workers URL，例如：`https://your-worker.your-subdomain.workers.dev`

#### Anthropic 模式示例

发送 OpenAI 格式的请求：

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANTHROPIC_API_KEY" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

代理会自动：
1. 提取 `Authorization: Bearer xxx` 中的 API Key
2. 将 `gpt-4` 映射为 `claude-opus-4-5-20251101`（如果配置了映射）
3. 转换为 Anthropic 格式
4. 在 system 和历史消息上添加 `cache_control`
5. 转发到 Anthropic API
6. 将响应转换回 OpenAI 格式

#### Passthrough 模式示例

发送 OpenAI 格式的请求：

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "MiniMax-M2",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

代理会自动：
1. 提取 `Authorization: Bearer xxx` 中的 API Key
2. 将 `MiniMax-M2` 映射为 `claude-opus-4-6`（如果配置了映射）
3. 直接转发 OpenAI 格式请求到目标接口
4. 返回原始响应（保持 OpenAI 格式）

## 缓存策略

代理会自动在以下位置添加 `cache_control`（1h TTL）：

1. **System 消息**：最后一个 system 块
2. **历史对话**：倒数第2条 assistant 消息（如果存在）

这样可以最大化缓存命中率，节省成本（缓存读取仅需 10% 成本）。

## 本地开发

```bash
# 安装依赖
npm install

# 复制环境变量示例文件
cp .dev.vars.example .dev.vars

# 编辑 .dev.vars 填入实际配置
# 本地开发（启动开发服务器）
npm run dev

# 访问 http://localhost:8787
```

### 查看实时日志

```bash
# 本地开发日志（自动显示）
npm run dev

# 生产环境实时日志
npx wrangler tail
```

## 配置说明

### wrangler.toml

```toml
name = "openai-claude-proxy"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
# 可选：自定义 Anthropic API 端点
# ANTHROPIC_BASE_URL = "https://api.anthropic.com"

# 可选：模型名称映射
MODEL_MAPPING = "gpt-4:claude-opus-4-5-20251101,gpt-3.5-turbo:claude-3-5-haiku-20241022"

# 可选：Max Tokens 映射
MAX_TOKENS_MAPPING = "claude-opus-4-5-20251101:16384,claude-3-5-sonnet-20241022:8192"

# 可选：Session TTL（分钟）
SESSION_TTL_MINUTES = "60"
```

## 支持的功能

| 功能 | 支持状态 |
|------|---------|
| 基础消息转换 | ✅ |
| System 消息 | ✅ |
| 流式响应 | ✅ |
| 工具调用（Function Calling） | ✅ |
| 图片消息 | ✅ |
| 自动缓存（Prompt Caching） | ✅ (1h TTL) |
| 多轮对话 | ✅ |
| 温度/TopP 等参数 | ✅ |
| 模型映射 | ✅ |
| 完整请求日志 | ✅ |

## 使用场景

### 1. 在现有 OpenAI 客户端中使用 Claude（Anthropic 模式）

如果你有使用 OpenAI API 的应用，只需修改 base URL：

```python
import openai

client = openai.OpenAI(
    base_url="https://your-worker.your-subdomain.workers.dev/v1",
    api_key="YOUR_ANTHROPIC_API_KEY"
)

response = client.chat.completions.create(
    model="gpt-4",  # 会自动映射到 claude-opus-4
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### 2. 统一多个 LLM 提供商（Passthrough 模式）

通过模型映射，可以在不修改代码的情况下切换不同的模型：

```bash
# 配置映射
PROXY_MODE = "passthrough"
ANTHROPIC_BASE_URL = "https://api.minimax.com"
MODEL_MAPPING = "MiniMax-M2:claude-opus-4-6,gpt-4:minimax-pro"

# 客户端代码无需修改
model="MiniMax-M2"  # 实际使用 claude-opus-4-6
```

### 3. 利用 Prompt Caching 节省成本（Anthropic 模式）

代理自动添加缓存控制，对于重复的 system prompt 和历史对话，缓存命中后成本降低 90%。

### 4. 跨平台模型名称统一

使用统一的模型名称（如 `MiniMax-M2`），通过代理映射到不同平台的实际模型名，简化客户端代码。

## 日志与监控

代理提供完整的请求日志功能，所有 API 请求的详细信息都会在 Cloudflare Observability 中展示。

### 日志类型

- 📥 **请求开始**：记录完整请求信息（URL、Headers、Body、API Key **模型映射**：记录模型名称映射过程
- 🔄 **代理模式**：记录使用的代理模式（Anthropic / Passthrough）
- 📤 **上游请求**：记录发送到上游 API 的请求
- 📨 **上游响应**：记录上游 API 的响应状态
- ✅ **请求完成**：记录请求成功完成及耗时
- 🌊 **流式响应**：记录流式响应的开始和完成
- 记录所有错误及堆栈信息

### 查看日志

**本地开发**：
```bash
npm run dev
# 日志会自动显示在终端
```

**生产环境**：
```bash
# 实时日志
npx wrangler tail

# 或在 Cloudflare Dashboard 查看
# Workers & Pages → 你的 Worker → Logs 标签
```

### 日志示例

```json
📥 [REQUEST_START] {
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "tim: "2026-03-03T02:00:00.000Z",
  "method": "POST",
  "url": "https://your-worker.workers.dev/v1/chat/completions",
  "body": {
    "model": "gpt-4",
    "messages": [...]
  },
  "apiKeyPrefix": "sk-ant-a..."
}

🔄 [MODEL_MAPPING] gpt-4 -> claude-opus-4-5-20251101

✅ [REQUEST_COMPLETE] {
  "requestId": "550e8400-e29b-41d4-a716-446655
  "duration": 1234,
  "response": {...}
}
```

每个请求都有唯一的 `requestId`，可以追踪完整的请求生命周期。

详细说明请参考 [LOGGING.md](./LOGGING.md)。

## 注意事项

1. **API Key 安全**：API Key 通过请求头传递，Workers 不会存储
2. **缓存要求**：被缓存的内容需要 >= 1024 tokens
3. **免费额度**：Cloudflare Workers 每天 100,000 次免费请求
4. **请求限制**：单个请求最大 10MB，响应最大 25MB

## 故障排查

### 部署失败

```bash
# 检查 Wrangler 版本
npx wrangler --version

# 重新登录
npx wrangler logout
npx wrangler login

# 重新部署
npm run deploy
```

### 查 API Key 是否正确
2. 检查模型映射配置是否正确
3. 查看 Workers 日志：
   ```bash
   # 实时日志
   npx wrangler tail
   
   # 或在 Dashboard 查看
   # Cloudflare Dashboard → Workers → 你的 Worker → Logs
   ```
4. 检查日志中的 `requestId` 追踪完整请求流程
5. 查看错误日志中的详细堆栈信息

## 项目结构

```
cloudflare-proxy/
├── src/
│   ├── index.ts        # 主入口，处理请求路由
│   ├── converter.ts    # OpenAI ↔ Anthropic 格式转换
│   ├── logger.ts       # 日志工具模块
│   └── types.ts        # TypeScript 类型定义
├── .dev.vars.example   # 本地开发环境变量示例
├── package.json        # 项目配置
├── tsconfig.json       # TypeScript 配置
├── wrangler.toml       # Cloudflare Workers 配置
├── README.md       ── LOGGING.md          # 日志功能详细说明
└── DEPLOY.md           # 部署指南
```

## License

MIT

## 参考

- 原始项目：[openai-claude-proxy](https://github.com/nickjerome/openai-claude-proxy)
- Cloudflare Workers 文档：https://developers.cloudflare.com/workers/
- Anthropic API 文档：https://docs.anthropic.com/
