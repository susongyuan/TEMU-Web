# TEMU Web Monitor

服务器部署包：Docker 同时运行 MySQL 和 TEMU Web 看板。

## 快速部署

```bash
cp .env.server.example .env
nano .env
docker compose -f docker-compose.server.yml --env-file .env up -d --build
```

访问：

```text
http://服务器IP:3106
```

详细步骤见 `docs/部署说明.md`。

## 架构

- 云服务器：MySQL + Web 看板。
- 本机 Windows：领星爬虫和仓库库存刷新，每 4 小时写入云服务器 MySQL。
- 服务器不运行爬虫，不保存浏览器登录态。
