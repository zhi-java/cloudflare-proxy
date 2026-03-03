# 部署指南

## 方式一：使用 Wrangler CLI（推荐）

### 1. 安装依赖

```bash
cd cloudflare-proxy
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

这会打开浏览器，让你登录 Cloudflare 账号并授权。

### 3. 配置环境变量

编辑 `wrangler.toml`，添加你需要的配置：

```toml
[vars]
# OpenAI 模型映射到 Claude 模型
MODEL_MAPPING = "gpt-4:claude-opus-4-5-20251101,gpt-3.5-turbo:claude-3-5-haiku-20241022,gpt-4-turbo:claude-3-5-sonnet-20241022"

# 每个模型的 max_tokens 配置
MAX_TOKENS_MAPPING = "claude-opus-4-5-20251101:16384,claude-3-5-sonnet-20241022:8192,claude-3-5-haiku-20241022:4096"

# Session 轮换周期（分钟）
SESSION_TTL_MINUTES = "60"
```

### 4. 部署

```bash
npm run deploy
```

部署成功后，你会看到类似输出：

```
Published openai-claude-proxy (1.0.0)
  https://openai-claude-proxy.your-subdomain.workers.dev
```

### 5. 测试

```bash
curl https://openai-claude-proxy.your-subdomain.workers.dev/health
```

应该返回：

```json
{
  "status": "ok",
  "service": "OpenAI to Anthropic Proxy (Cloudflare Workers)",
  "version": "1.0.0"
}
```

## 方式二：通过 Cloudflare Dashboard

### 1. 准备代码

由于 Cloudflare Dashboard 只支持单文件上传，需要将代码合并。

创建 `dist/worker.js`：

```bash
# 安装 esbuild
npm install -D esbuild

# 构建单文件
npx esbuild src/index.ts --bundle --format=esm --outfile=dist/worker.js
```

### 2. 登录 Cloudflare Dashboard

访问：https://dash.cloudflare.com/

### 3. 创建 Worker

1. 点击左侧菜单 **Workers & Pages**
2. 点击 **Create application**
3. 选择 **Create Worker**
4. 输入名称：`openai-claude-proxy`
5. 点击 **Deploy**

### 4. 编辑代码

1. 点击 **Edit code**
2. 删除默认代码
3. 复制 `dist/worker.js` 的内容
4. 粘贴到编辑器
5. 点击 **Save and Deploy**

### 5. 配置环境变量

1. 返回 Worker 详情页
2. 点击 **Settings** → **Variables**
3. 添加环境变量：

| 变量名 | 值 |
|--------|---|
| `MODEL_MAPPING` | `gpt-4:claude-opus-4-5-20251101,gpt-3.5-turbo:claude-3-5-haiku-20241022` |
| `MAX_TOKENS_MAPPING` | `claude-opus-4-5-20251101:16384,claude-3-5-sonnet-20241022:8192` |
| `SESSION_TTL_MINUTES` | `60` |

4. 点击 **Save**

### 6. 获取 Worker URL

在 Worker 详情页，你会看到 URL：

```
https://openai-claude-proxy.your-subdomain.workers.dev
```

## 方式三：使用 GitHub Actions 自动部署

### 1. 创建 Cloudflare API Token

1. 访问：https://dash.cloudflare.com/profile/api-tokens
2. 点击 **Create Token**
3. 选择 **Edit Cloudflare Workers** 模板
4. 配置权限：
   - Account → Workers Scripts → Edit
5. 点击 **Continue to summary** → **Create Token**
6. 复制生成的 Token

### 2. 配置 GitHub Secrets

在你的 GitHub 仓库中：

1. 进入 **Settings** → **Secrets and variables** → **Actions**
2. 添加以下 Secrets：

| Secret 名称 | 值 |
|------------|---|
| `CLOUDFLARE_API_TOKEN` | 你的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Account ID（在 Cloudflare Dashboard 右侧） |

### 3. 创建 GitHub Actions Workflow

创建 `.github/workflows/deploy.yml`：

```yaml
name: Deploy to Cloudflare Workers

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm install
        working-directory: cloudflare-proxy
      
      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: cloudflare-proxy
```

### 4. 推送代码

```bash
git add .
git commit -m "Add Cloudflare Workers deployment"
git push origin main
```

GitHub Actions 会自动部署到 Cloudflare Workers。

## 配置自定义域名（可选）

### 1. 添加域名

1. 在 Worker 详情页，点击 **Triggers** → **Custom Domains**
2. 点击 **Add Custom Domain**
3. 输入你的域名，例如：`api.yourdomain.com`
4. 点击 **Add Custom Domain**

### 2. 配置 DNS

Cloudflare 会自动添加 DNS 记录。如果你的域名不在 Cloudflare，需要手动添加 CNAME 记录：

```
api.yourdomain.com → openai-claude-proxy.your-subdomain.workers.dev
```

### 3. 测试

```bash
curl https://api.yourdomain.com/health
```

## 更新部署

### 使用 Wrangler

```bash
npm run deploy
```

### 使用 Dashboard

重复"方式二"的步骤 4。

### 使用 GitHub Actions

推送代码到 `main` 分支即可自动部署。

## 监控和日志

### 查看日志

1. 进入 Worker 详情页
2. 点击 **Logs** → **Begin log stream**
3. 发送请求，实时查看日志

### 查看指标

1. 进入 Worker 详情页
2. 点击 **Metrics**
3. 查看请求数、错误率、延迟等指标

## 故障排查

### 部署失败

```bash
# 检查 Wrangler 版本
npx wrangler --version

# 更新 Wrangler
npm install -g wrangler@latest

# 重新登录
npx wrangler logout
npx wrangler login
```

### 请求 401 错误

检查 API Key 是否正确：

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_ANTHROPIC_API_KEY" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'
```

### 请求 500 错误

查看 Worker 日志，检查是否有错误信息。

### 模型映射不生效

检查 `wrangler.toml` 中的 `MODEL_MAPPING` 配置是否正确：

```toml
[vars]
MODEL_MAPPING = "gpt-4:claude-opus-4-5-20251101"
```

## 成本估算

Cloudflare Workers 免费计划：

- 每天 100,000 次请求
- 每次请求最多 10ms CPU 时间
- 每次请求最多 128MB 内存

对于大多数个人和小型项目，免费计划完全够用。

如果需要更多请求，可以升级到 Workers Paid 计划（$5/月）：

- 每月 1000 万次请求
- 超出部分 $0.50/百万次请求
