# ai-fix GitHub Action

当 GitHub PR 对话里有人评论 `/ai-fix` 时，GitHub Actions 会自动运行脚本：

1. 拉取该 PR 的变更文件、行内 review 评论和对话评论。
2. 把上下文发给 DeepSeek API，DeepSeek 返回 JSON 格式的 unified git diff。
3. 脚本在临时目录 checkout PR head，应用 diff。
4. 自动 commit 并 push 回 PR 分支。
5. 在 PR 里回复提交结果。

这套方案不需要单独运行 Webhook 监听服务，也不需要 ngrok、`.env` 或公网地址。

## 文件

- `.github/workflows/ai-fix.yml`：GitHub Actions 工作流，监听 `issue_comment`。
- `run-ai-fix.mjs`：单次执行入口，实际完成拉取上下文、调用 DeepSeek、commit 和 push。
- `test/index.test.js`：针对 prompt 组装和 patch 解析的单元测试。

## 首次配置

1. 把代码和 `.github/workflows/ai-fix.yml` push 到仓库的默认分支。
2. 打开仓库 `Settings > Secrets and variables > Actions`。
3. 点击 `New repository secret`，添加：
   - Name：`DEEPSEEK_API_KEY`
   - Secret：你的真实 DeepSeek API key
4. 不需要配置 `GITHUB_TOKEN`。工作流里的 `${{ github.token }}` 会自动提供写代码和回复评论的权限。

工作流权限已经在 `.github/workflows/ai-fix.yml` 中声明：

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: write
```

## 使用

在目标 PR 的对话里评论：

```text
/ai-fix 请处理下面的 review 意见
```

然后到仓库 `Actions` 页面查看 `ai-fix` 工作流日志。

DeepSeek 不是能自主执行命令的 agent，它只负责根据脚本提供的上下文返回 patch；应用、提交和推送由 `run-ai-fix.mjs` 完成。

## 本地手动运行

如果想在 push 之前手动测试真实流程，复制 `.env.example` 为 `.env`，填入：

```bash
GITHUB_TOKEN=github_pat_xxx
GITHUB_REPOSITORY=owner/repo
PR_NUMBER=123
DEEPSEEK_API_KEY=sk-xxx
```

然后运行：

```bash
node run-ai-fix.mjs
```

本地手动运行会真实提交并 push，请使用测试仓库和测试 PR。

运行单元测试：

```bash
npm test
```

## 限制

- 工作流要能被 GitHub 触发，`.github/workflows/ai-fix.yml` 必须存在于默认分支。
- 脚本读取 `refs/pull/N/head`，但 push 使用当前仓库的 workflow token，因此不支持 fork 出来的 PR。
- 评论 `/ai-fix` 会直接改 PR 分支；若要验证，建议先用测试仓库。
- 所有 secret 都放在 GitHub Actions Secrets 中，不要写入代码或 `.env` 后提交。
