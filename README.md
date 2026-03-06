# CLOUDflare-PROXY // 不改客户端，直接换引擎

<div align="center">

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zhi-java/cloudflare-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-111111.svg)](./LICENSE)
[![Runtime](https://img.shields.io/badge/Runtime-Cloudflare%20Workers-f38020)](https://workers.cloudflare.com/)
[![Protocol](https://img.shields.io/badge/API-OpenAI%20Compatible-5a67d8)](#调用示例)

</div>

---

> 你已经有一套跑着的 OpenAI 客户端。  
> 你不想重写。  
> 你只想把上游模型切掉。  
>
> 这就是这个项目存在的理由。

---

## 0x01｜这项目一眼看懂

`cloudflare-proxy` 是一层部署在 Cloudflare Workers 的协议代理：

- 保持 OpenAI 调用方式不变；
- 按需转 Anthropic（或透传到其他兼容上游）；
- 让迁移从“大手术”变成“切一条 URL”。

---

## 0x02｜能力矩阵（核心能力直接摊开）

| 能力 | 状态 | 说明 |
|---|---|---|
| OpenAI -> Anthropic 格式转换 | 支持 | `anthropic` 模式下自动完成 |
| OpenAI 透传 | 支持 | `passthrough` 模式原样转发 |
| 流式响应（SSE） | 支持 | 聊天流式输出可用 |
| Tool Calling | 支持 | 工具调用结构映射 |
| 图片消息 | 支持 | 图文请求可转换 |
| 模型映射 | 支持 | `MODEL_MAPPING` 可控 |
| 健康检查/指标 | 支持 | `/health` `/metrics` `/circuit-breakers` |
| 稳定性默认策略 | 支持 | 超时、重试、熔断内置默认值 |

---

## 0x03｜一键部署（GitHub 页面直接点）

<div align="left">

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zhi-java/cloudflare-proxy)

</div>

点击按钮后按向导完成授权，部署完成会得到：

`https://<your-worker>.<subdomain>.workers.dev`

---

## 0x04｜30 秒命令行部署（给控制流玩家）

```bash
git clone https://github.com/zhi-java/cloudflare-proxy.git
cd cloudflare-proxy
npm install
npx wrangler login
npm run deploy
```

---

## 0x05｜最小配置（开箱可用版本）

目前推荐只维护 3 个核心参数：

```toml
name = "openai-claude-proxy"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
# anthropic（格式转换）/ passthrough（透传）
PROXY_MODE = "passthrough"

# 你的上游 API
UPSTREAM_BASE_URL = "https://api.daiju.live"

# 可选：模型映射，格式 source:target，多个用逗号分隔
MODEL_MAPPING = ""
```

### 参数说明（只留重点）

| 变量名 | 建议 | 说明 |
|---|---|---|
| `PROXY_MODE` | 必配 | `anthropic` / `passthrough` |
| `UPSTREAM_BASE_URL` | 必配 | 上游 API 基础地址 |
| `MODEL_MAPPING` | 可选 | 例如：`gpt-4:claude-opus-4-5-20251101` |
| `MAX_TOKENS_MAPPING` | 可选 | 不配也行，代码内有默认策略 |

> 说明：超时、重试、熔断、日志等级、Session TTL 已有代码默认值；只有你明确需要覆盖时才额外配置。

---

## 0x06｜调用示例

### Anthropic 模式

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "user", "content": "你好，给我一句话介绍你自己"}
    ]
  }'
```

### Passthrough 模式

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "your-model",
    "messages": [
      {"role": "user", "content": "hello"}
    ],
    "stream": true
  }'
```

---

## 0x07｜监控与排障

| 端点 | 用途 |
|---|---|
| `GET /health` | 服务与上游健康状态 |
| `GET /metrics` | 基础运行指标 |
| `GET /circuit-breakers` | 熔断器状态 |

实时日志查看：

```bash
npx wrangler tail
```

---

## 0x08｜为什么它适合“平滑迁移”

它帮你吞掉了最容易炸的那部分：

- 协议差异；
- 流式事件映射；
- 工具调用结构转换；
- 可靠性兜底。

你要改的通常只有一个地方：**base URL**。

---

## 0x09｜三种典型接入场景（照着抄就能落地）

### 场景 A：已有 OpenAI 客户端，零侵入切换

**你现在有：** 已上线业务，调用都走 OpenAI SDK。  
**你要做：** 只改 `base_url` 到 Worker 地址。  
**收益：** 客户端代码几乎不动，迁移成本最低。

---

### 场景 B：多模型网关统一出口

**你现在有：** 多个模型供应商，调用入口混乱。  
**你要做：** 统一收口到本代理，用 `MODEL_MAPPING` 管理路由。  
**收益：** 平台切换、灰度、成本策略都能在网关层做。

---

### 场景 C：灰度迁移与回滚

**你现在有：** 线上稳定系统，不敢一次性替换。  
**你要做：** 先透传（`passthrough`），再逐步切 `anthropic` 转换。  
**收益：** 风险可控，回滚路径清晰，不用赌一把。

---

## 0x0A｜FAQ（高危问题速查）

### Q1：为什么返回 401？

通常是 `Authorization` 头缺失或格式错误。  
必须是：`Authorization: Bearer <API_KEY>`。

### Q2：为什么一直超时？

优先检查：

1. `UPSTREAM_BASE_URL` 是否可达；
2. 上游服务是否限流或阻塞；
3. 请求体是否过大（尤其长上下文 + 流式）。

### Q3：为什么上游频繁 429？

这是上游限流，不是代理崩了。  
建议先做：降低并发、开启排队、按模型拆流量。

### Q4：流式输出中断怎么办？

先看 `wrangler tail` 日志定位中断点；  
再检查上游是否提前断流，或客户端是否超时关闭连接。

### Q5：为什么模型映射没生效？

确认两点：

- `MODEL_MAPPING` 格式是否正确（`a:b,c:d`）；
- 请求里的 `model` 名称与映射左侧是否完全一致。

---

## 0x0B｜本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

本地地址：`http://localhost:8787`

---

## 0x0C｜项目结构

```text
cloudflare-proxy/
├── src/
│   ├── index.ts
│   ├── converter.ts
│   ├── logger.ts
│   └── types.ts
├── wrangler.toml
├── .dev.vars.example
├── package.json
└── README.md
```

---

## License

MIT

---

## 0x0D｜最后一行

如果你不想再经历一次“为了换模型把业务重写”的灾难，
那就把请求入口接到这里，剩下的交给代理层。