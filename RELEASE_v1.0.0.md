# Release v1.0.0 - OpenAI to Anthropic Proxy

## 🎉 首个正式版本

OpenAI to Anthropic Proxy 是一个部署在 Cloudflare Workers 上的轻量级代理服务，将 OpenAI 格式的请求转换为 Anthropic Claude 格式，完全免费。

## ✨ 核心功能

### 双模式支持
- **Anthropic 模式**：完整的 OpenAI → Anthropic 格式转换
- **Passthrough 模式**：直接转发 enAI 格式到任意兼容接口

### 格式转换
- ✅ 完整的 OpenAI Chat Completions API → Anthropic Messages API 转换
- ✅ System 消息处理
- ✅ 多轮对话支持
- ✅ 工具调用（Function Calling）完整转换
- ✅ 图片消息支持
- ✅ 流式响应（SSE）
- ✅ 温度、Top
### 智能优化
- ✅ **自动 Prompt Caching**：智能在 system 和历史消息添加 `cache_control`（1h TTL）
- ✅ **模型名称映射**：支持任意模型名映射（如 `gpt-4` → `claude-opus-4-5-20251101`）
- ✅ **Max Tokens 自动识别**：根据模型名称自动选择合理的 max_tokens 默认值

### 日志与监控 🆕
- ✅ **完整请求日志**：所有 API 请求详情在 Cloudflare Observability 中展示
- ✅ **8 种日志类型**：请求开始、模型映射、代理模式、上游请求/响应、完成、流式、错误
- ✅ **请求追踪**：每个请求唯一 `requestId`，可追踪完整生命周期
- ✅ **API Key 脱敏**：日志中自动脱敏敏感信息

### 零配置部署
- ✅ API Key 从请求头自动提取，无需预配置
- ✅ 部署在 Cloudflare Workers，每天 100,000 次免费请求
- ✅ 全球 CDN 加速，低延迟

## 📦 部署方式

### 方式一：Wrangler CLI（推荐）

```bash
# 克隆项目
git clone https://github.com/zhi-java/cloudflare-proxy.git
cd cloudflare-proxy

# 安装依赖
npm install

# 复制环境变量示例
cp .dev.vars.example .dev.vars

# 编辑 .dev.vars 填入配置

# 登录 Cloudflare
npx wrangler login

# 部署
npm run deploy
```

### 方式二：Cloudflare Dashboard

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 Workers & Pages
3. 创建新的 Worker
4. 复制代码并配置环境变量
5. 保存并部署

详细部署指南请参考 [DEPLOY.md](./DEPLOY.md)

## 🔧 配置说明

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PROXY_MODE` | 代理模式：`anthropic` 或 `passthrough` | `anthropic` |
| `ANTHROPIC_BASE_URL` | 目标 API 端点 | `https://api.anthropic.com` |
| `MODEL_MAPPING` | 模型名称映射 | 空 |
| `MAX_TOKENS_MAPPING` | Max tokens 映射选） | 自动识别 |
| `SESSION_TTL_MINUTES` | Session TTL（分钟） | `60` |

### Anthropic 模式示例

```bash
PROXY_MODE=anthropic
ANTHROPIC_BASE_URL=https://api.anthropic.com
MODEL_MAPPING=gpt-4:claude-opus-4-5-20253.5-turbo:claude-3-5-haiku-20241022
```

### Passthrough 模式示例

```bash
PROXY_MODE=passthrough
ANTHROPIC_BASE_URL=https://api.minimax.com
MODEL_MAPPING=MiniMax-M2:claude-opus-4-6
```

## 📊 使用示例

### Python

```python
import openai

client = openai.OpenAI(
    base_url="https://your-worker.workers.dev/v1",
    api_key="YOUR_ANTHROPIC_API_KEY"
)

responsent.chat.completions.create(
    model="gpt-4",  # 自动映射到 claude-opus-4
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### cURL

```bash
curl https://your-worker.wor/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## 📝 日志查看

### 本地开发

```bash
npm run dev
# 日志自动显示在终端
```

### 生产环境

```bash
# 实时日志
npx wrangler tail

# 或在 Cloudflare Dashboard 查看
# Workers & Pages → 你的 Worker → Logs
```

详细日志说明请参考 [LOGGING.md](./LOGGING.md)

## 📁 项目结构

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
├── README.md           # 项目文档
├── LOGGING.md          # 日志功能详细说明
└── DEPLOY.md           # 部署指南
```

## 🎯 使用场景

1. **在现有 OpenAI 客户端中使用 Claude**：只需修改 base URL
2. **统一多个 LLM 提供商**：通过模型映射切换不同模型
3. **利用 Prompt Caching 节省成本**：自动添加缓存控制，成本降低 90%
4. **跨平台模型名称统一**：使用统一模型名，简化客户端代码

## ⚠️ 注意事项

1. **API Key 安全**：API Key 通过请求头传递，Workers 不会存 **缓存要求**：被缓存的内容需要 >= 1024 tokens
3. **免费额度**：Cloudflare Workers 每天 100,000 次免费请求
4. **请求限制**：单个请求最大 10MB，响应最大 25MB

## 🔗 相关链接

- **GitHub 仓库**：https://github.com/zhi-java/cloudflare-proxy
- **Cloudflare Workers 文档s://developers.cloudflare.com/workers/
- **Anthropic API 文档**：https://docs.anthropic.com/

## 📄 License

MIT

## 🙏 致谢

基于 [openai-claude-proxy](https://github.com/nickjerome/openai-claude-proxy) 项目改进。

---

**完整文档**：https://githuva/cloudflare-proxy/blob/main/README.md

**问题反馈**：https://github.com/zhi-java/cloudflare-proxy/issues
