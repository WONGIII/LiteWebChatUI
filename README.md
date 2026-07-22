# <img src="public/logo.svg" width="36" height="36" style="vertical-align:middle;margin-right:8px;"> LiteChat

轻量化、开箱即用的多用户 AI 对话网站。部署后首次进入创建管理员账号，管理面板支持配置多个 OpenAI 兼容格式的 API 提供商，控制模型对普通用户的可见性。

## 特性

- **零构建** — 纯 HTML/CSS/JS 前端，Node.js 单文件后端，无需 webpack/vite
- **多用户审核** — 开放注册，管理员审核通过后方可使用
- **多 API 提供商** — 支持同时配置多个 OpenAI 兼容 API（OpenAI / DeepSeek / Ollama 等）
- **流式输出** — SSE 实时推送，切换对话不中断
- **思考链** — 支持 DeepSeek R1 等推理模型的思考过程展示，折叠/展开动画
- **Markdown 渲染** — 完整支持标题、列表、表格、引用、代码块，HTML 代码可一键运行
- **深色/浅色主题** — 自由切换
- **响应式** — 桌面端和移动端自适应
- **Docker 部署** — 提供 Dockerfile 和 docker-compose

## 快速开始

```bash
npm install
node server.js
```

浏览器打开 `http://localhost:3000`，首次访问自动进入管理员创建页面。

### Docker

```bash
docker-compose up -d
```

## 管理面板

1. 创建管理员账号后自动跳转管理面板
2. 添加 API 提供商（Base URL + API Key）
3. 获取模型列表，或手动添加自定义模型
4. 上传模型 Logo
5. 控制模型可见性（公开 / 私密），支持批量操作
6. 管理用户（审核 / 驳回 / 删除）

## 技术栈

- **后端**：Node.js + better-sqlite3 + bcrypt
- **前端**：HTML/CSS/JS（零依赖构建），Lucide 图标，highlight.js
- **数据库**：SQLite（单文件，零配置）
- **认证**：Session Cookie + bcrypt

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |

## 协议

MIT
