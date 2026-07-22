# LiteChat — AI 对话网站设计文档

> 创建时间: 2026-07-22
> 状态: 设计中

---

## 1. 项目目标

构建一个轻量化、开箱即用的多用户 AI 对话网站。部署后首次进入时创建管理员账号，管理员可通过管理面板配置 OpenAI 兼容格式的 API 提供商及模型，控制模型对普通用户的可见性（公开/私密）。前端参考 ChatGPT 对话界面风格，注重流式输出体验和思考链展示。

---

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 后端运行时 | Node.js (v22+) | 无需额外 Web Server，单进程 |
| 后端框架 | 原生 `http` 模块 | 零 npm 依赖处理 HTTP/SSE 可行，但为了路由方便引入轻量 `mime` + 手动路由 |
| 数据库 | SQLite (better-sqlite3) | 零配置单文件，同步 API 简洁 |
| 前端 | 原生 HTML/CSS/JS | 零构建步骤，无 webpack/vite |
| 图标 | Lucide Icons (内联 SVG) | ISC License 开源可商用，极轻量 |
| 代码高亮 | highlight.js (CDN) | 按需加载，不打包 |
| 部署 | node server.js / Docker | 两种方式均支持 |

## 3. 项目结构

```
litewebchatui/
  server.js              # 后端入口 (~800行)
  chat.db                # SQLite 数据库 (自动生成)
  public/
    index.html           # 聊天界面 SPA
    admin.html           # 管理面板 SPA
    login.html           # 登录/注册页面
    style.css            # 全局样式 (含浅色/深色主题)
    app.js               # 聊天核心逻辑 (SSE 流式, 思考链)
    admin.js             # 管理面板逻辑
    login.js             # 登录/注册逻辑
  uploads/               # 模型 Logo 上传目录
  Dockerfile
  docker-compose.yml
```

## 4. 数据模型 (SQLite)

```sql
-- 用户表
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- API 提供商配置
CREATE TABLE providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 模型列表 (从 API 获取后缓存)
CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER REFERENCES providers(id),
  model_id TEXT NOT NULL,           -- e.g. "gpt-4o"
  display_name TEXT,                -- e.g. "GPT-4o" (可编辑)
  logo_url TEXT,                    -- 上传的 logo 路径
  visible INTEGER DEFAULT 1,        -- 1=公开, 0=私密(仅管理员可见)
  context_window INTEGER,
  max_tokens INTEGER,
  supports_reasoning INTEGER DEFAULT 0, -- 是否支持思考链
  supports_vision INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 对话会话
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  title TEXT DEFAULT '新对话',
  model_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_conv_user ON conversations(user_id, updated_at DESC);

-- 消息记录
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,               -- 'user' | 'assistant'
  content TEXT NOT NULL,
  reasoning TEXT,                   -- 思考链内容 (可为 NULL)
  tokens_used INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_msg_conv ON messages(conversation_id, created_at);
```

## 5. API 设计

所有 API 均为 JSON。认证通过 Session Cookie + 内存 Session Store。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 (首个用户自动成为管理员) |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 获取当前用户信息 |
| POST | `/api/admin/setup` | 初始化管理员 (首次部署) |
| GET | `/api/admin/providers` | 获取提供商列表 |
| POST | `/api/admin/providers` | 添加/更新提供商配置 |
| DELETE | `/api/admin/providers/:id` | 删除提供商 |
| POST | `/api/admin/providers/:id/fetch` | 从 API 获取模型列表 |
| GET | `/api/admin/models` | 获取所有模型 |
| PATCH | `/api/admin/models/:id` | 更新模型 (名称/可见性/logo) |
| POST | `/api/admin/models/:id/logo` | 上传模型 Logo |
| GET | `/api/models` | [普通用户] 获取可见模型列表 |
| GET | `/api/conversations` | 获取当前用户会话列表 |
| POST | `/api/conversations` | 创建新会话 |
| PATCH | `/api/conversations/:id` | 更新会话 (标题等) |
| DELETE | `/api/conversations/:id` | 删除会话 |
| GET | `/api/conversations/:id/messages` | 获取会话消息 |
| POST | `/api/chat/completions` | 发送消息 (SSE 流式响应) |

---

## 6. SSE 流式响应设计

`POST /api/chat/completions` 返回 SSE 流，事件类型：

```
event: reasoning
data: {"delta":"分析用户需求...","index":0}

event: reasoning
data: {"delta":"评估可行性...","index":0}

event: reasoning_done
data: {"index":0}

event: content
data: {"delta":"实现","index":0}

event: content
data: {"delta":" React","index":0}

event: done
data: {"tokens":{"prompt":142,"completion":387}}
```

前端解析 SSE，分别渲染思考链竖线和正文内容。思考链竖线随 `reasoning` 事件实时拉长，`reasoning_done` 后转折叠态。

---

## 7. 前端架构

### 7.1 聊天页面 (index.html)

```
+------------------+------------------------------------+
|    侧栏 (260px)   |         对话主区域                    |
|                  |                                    |
|  [+ 新对话]       |  [模型选择器: GPT-4o               ] |
|                  |                                    |
|  会话列表         |  用户消息 ---------------> (右对齐)  |
|  * 关于React      |                                    |
|    晚饭吃什么      |  AI 头像                          |
|    写排序函数      |  |-- 已深度思考 · 用时3s (可折叠)   |
|                  |  |   思考内容展开区...               |
|                  |  正文回复                          |
|                  |                                    |
|                  |  [输入框__________________] [发送]  |
+------------------+------------------------------------+
```

**桌面端**: 侧栏 + 主区域并排，侧栏 260px 固定宽度
**移动端 (<768px)**: 侧栏隐藏，通过汉堡菜单滑入/覆盖显示；对话占满全宽

### 7.2 管理面板 (admin.html)

```
+------------------------------------------+
|  管理面板                    [已连接]      |
+------------------------------------------+
|  Base URL: [https://api.openai.com/v1  ] |
|  API Key:  [sk-****                    ] |
|  [获取模型列表]                            |
+------------------------------------------+
|  Logo | 模型名称    | 模型ID      | 可见   |
|  [G]  | GPT-4o      | gpt-4o      | [ON]  |
|  [Gm] | GPT-4o-mini | gpt-4o-mini | [ON]  |
|  [+]  | Claude 3.5  | claude-3.5  | [OFF] |
+------------------------------------------+
```

**移动端**: 表格改为卡片列表，每个模型一卡片

### 7.3 主题切换

CSS 变量方案，`:root` 定义浅色变量，`[data-theme="dark"]` 覆盖为深色。默认浅色，用户可手动切换，选择通过 localStorage 持久化。

```css
:root {
  --bg-primary: #ffffff;
  --bg-secondary: #f9fafb;
  --bg-tertiary: #f3f4f6;
  --text-primary: #111827;
  --text-secondary: #374151;
  --text-tertiary: #6b7280;
  --border-primary: #e5e7eb;
  --border-secondary: #f3f4f6;
}
[data-theme="dark"] {
  --bg-primary: #1a1a2e;
  --bg-secondary: #16213e;
  --bg-tertiary: #0f3460;
  --text-primary: #e5e7eb;
  --text-secondary: #d1d5db;
  --text-tertiary: #9ca3af;
  --border-primary: #2d2d44;
  --border-secondary: #252540;
}
```

---

## 8. 渲染与体验细节

### 8.1 自动滚动

- 用户未手动滚动滚轮时，新消息到达自动滚动到底部
- 用户向上滚动查看历史时（距离底部 > 120px），停止自动滚动
- 用户滚回底部（距离底部 < 40px），恢复自动滚动
- 发送新消息时强制滚动到底部并恢复自动跟随

### 8.2 思考链渲染

三态切换（详见前端线框图 v4）：

1. **折叠态**: 灰线 `#d1d5db` + 灰字 `#9ca3af`，显示 "已深度思考 · 用时 Xs"，可点击展开
2. **展开态**: 黑线 `#374151` + 黑字标题，内容灰字，左侧竖线随高度自适应
3. **流式态**: 黑线 + 脉冲 opacity 动效，内容逐字追加，竖线随高度实时拉长

流式结束后自动折叠为状态 1（折叠态），已完成思考的动画过渡 500ms。

### 8.3 代码块

- 使用 highlight.js CDN 动态加载，仅当检测到代码块时注入
- 每个代码块右上角显示 "复制" 按钮，点击复制后显示 "已复制"
- 代码区可独立横向滚动

### 8.4 响应式断点

| 断点 | 布局 |
|------|------|
| >= 768px | 桌面端：侧栏可见，双栏布局 |
| < 768px | 移动端：侧栏抽屉式，全宽对话 |

### 8.5 管理面板 Logo 上传

- 点击 Logo 区域触发 `<input type="file">`
- 接受 PNG/JPG/SVG，裁剪为 40x40 圆形
- 上传后保存到 `uploads/` 目录，数据库记录路径
- 未上传时显示模型名首字母缩写 + 随机底色

---

## 9. 安全

- 密码: bcrypt 哈希存储，每用户独立 salt
- Session: 服务端内存 Session + Cookie，HttpOnly + SameSite=Strict
- API Key: 数据库中 AES-256-GCM 加密存储，管理员面板中掩码显示
- 输入: 所有用户输入做 XSS 转义 (escapeHtml)
- CSRF: SameSite Cookie + 检查 Origin/Referer

## 10. 部署

### 裸进程
```bash
npm install better-sqlite3
node server.js --port 3000
```

### Docker
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

```yaml
# docker-compose.yml
services:
  litechat:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./chat.db:/app/chat.db
      - ./uploads:/app/uploads
```

---

## 11. 自检清单

- [ ] 无占位符/TODO
- [ ] 前后端 API 一致
- [ ] 数据模型覆盖所有功能
- [ ] 深色/浅色变量完整
- [ ] 响应式断点明确
- [ ] SSE 事件类型定义清晰
- [ ] 安全机制覆盖 Auth / XSS / CSRF / Key 加密
