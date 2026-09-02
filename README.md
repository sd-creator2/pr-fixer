# ai-fix GitHub bot

一个监听 GitHub PR 评论的 Node.js 脚本。当有人评论 `/ai-fix` 时，脚本会把 PR 上下文发送给 DeepSeek API，用 DeepSeek 返回的 diff 修改代码，然后自动 commit 并 push 回 PR 分支，最后在 PR 里回复结果。

## 工作方式

1. GitHub Webhook 把 `issue_comment` 事件发送到本服务的 `/webhook`。
2. 评论正文以 `/ai-fix` 开头时，脚本从 GitHub API 拉取 PR、变更文件、行内 review 评论和对话评论。
3. 脚本把上下文组装成 prompt，请求 DeepSeek Chat Completions API 返回 JSON，其中 `patch` 是一份 unified git diff。
4. 脚本在本地临时目录 checkout PR head，应用 diff，然后 `git add`、`git commit`、`git push origin HEAD:<pr-branch>`。
5. 处理成功或失败都会通过 GitHub API 回复到 PR 对话中。

DeepSeek API 本身不会执行代码、跑测试或探索整个仓库；能修改什么完全由 prompt 里的 PR diff 和 review comments 决定。

## 运行要求

- Node.js 18+
- GitHub Personal Access Token（或可推送代码的 GitHub App 安装 token），权限需要：
  - `Contents: Read and write`
  - `Pull requests: Read and write`（或 `Issues: write` 用于回复评论）
- DeepSeek API key

## 配置

复制 `.env.example` 为 `.env` 并填写：

```bash
cp .env.example .env
```

需要设置的变量：

| 变量 | 说明 |
| --- | --- |
| `GITHUB_TOKEN` | GitHub token，需要能读 PR、改代码并 push |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret，必须和 GitHub Webhook 配置一致 |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `DEEPSEEK_MODEL` | 默认 `deepseek-chat`，可换成其他 DeepSeek 模型 |
| `DEEPSEEK_BASE_URL` | 默认 `https://api.deepseek.com`，可换成兼容端点 |
| `ALLOWED_REPOS` | 可选；逗号分隔的 `owner/repo`，留空则接受所有仓库 |
| `MAX_CONTEXT_CHARS` | 发送给模型的上下文上限 |
| `DEEPSEEK_MAX_TOKENS` | 模型回复的最大 token 数；patch 较大时可以调大 |
| `WORK_DIR` | checkout 的临时目录 |

## 启动

```bash
npm start
```

服务默认监听 `http://localhost:8787`，健康检查为 `GET /healthz`。

在 GitHub 仓库的 Settings > Webhooks 中新增 Webhook：

- Payload URL: `https://你的公网地址/webhook`
- Content type: `application/json`
- Secret: 与 `GITHUB_WEBHOOK_SECRET` 相同
- Which events: 选择 "Let me select individual events"，勾选 `Issue comments`

本地开发可以用 `ngrok http 8787` 之类工具把 `/webhook` 暴露到公网。

运行测试：

```bash
npm test
```

## 限制

- `/ai-fix` 应写在 PR 对话中（`issue_comment` 事件）；已有的行内 review 评论会被作为上下文发给 DeepSeek。
- 默认只支持同仓库 PR。fork 出来的 PR 无法用单个仓库 token 自动 push，脚本会明确报错。
- Webhook 收到后立即返回 202，DeepSeek 调用在后台执行；脚本重启会丢失正在进行的任务。
- `GITHUB_TOKEN` 必须对目标 PR 的分支有 push 权限。
- 同一时间同一个 PR 只允许一个任务，重复触发会被忽略。
