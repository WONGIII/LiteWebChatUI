# 贡献指南

感谢你愿意为 LiteChat 贡献代码。

## 如何贡献

1. Fork 本仓库
2. 创建你的功能分支：`git checkout -b feat/my-feature`
3. 提交你的改动：`git commit -m 'feat: 添加某某功能'`
4. 推送到分支：`git push origin feat/my-feature`
5. 提交 Pull Request

## 代码风格

- 前端使用 ES5 兼容语法（`var`，避免箭头函数），确保老旧浏览器兼容
- CSS 使用 `clamp()` 做响应式字号和间距
- 后端使用 ES Module + async/await
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)

## 项目结构

```
litewebchatui/
  server.js              # 后端入口
  public/
    style.css             # 全局样式
    login.html + login.js # 登录/注册页
    admin.html + admin.js # 管理面板
    index.html + app.js   # 聊天界面
  Dockerfile
  docker-compose.yml
```

## 运行开发环境

```bash
npm install
npm run dev    # node --watch server.js，修改自动重启
```

## 提交规范

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修复 Bug |
| `docs` | 文档更新 |
| `style` | 代码格式（不影响功能） |
| `refactor` | 重构 |
| `perf` | 性能优化 |
| `chore` | 构建/工具变更 |

## 协议

参与贡献即表示你同意将代码以 MIT 协议授权。
