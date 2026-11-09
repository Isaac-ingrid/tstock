# 股票数据后端

独立代理腾讯与东方财富行情源，负责跨域、超时、缓存和上游白名单校验。

## 启动

```bash
# 首次安装
cd backend
uv venv --python 3.12
uv pip install -r requirements.txt
cd ..

# 从项目根目录启动，避免与 Next.js 的 app/ 目录重名
npm run backend
# 或：backend/.venv/Scripts/python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 18765 --reload
```

前端复制 `.env.example` 为 `.env.local`，然后运行 `npm run dev`。

## 接口

- `GET /health`：健康检查
- `GET /api/proxy?url=<上游HTTPS地址>`：仅允许代码内配置的股票数据域名

本机的 8000 端口常被 Docker/WSL 占用，所以开发环境默认使用 18765。生产环境建议由 nginx 将 `/stock-api/` 反向代理到该服务，或在构建前端时设置 `NEXT_PUBLIC_STOCK_API_BASE`。
