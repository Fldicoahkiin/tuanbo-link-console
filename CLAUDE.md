# Claude Code · 团播联动台

@AGENTS.md

- 全程使用简体中文，专有名词保留英文。
- 文件搜索优先 Glob/`rg --files`，内容搜索优先 Grep/`rg`，源码修改用补丁（Edit）。
- 不读取凭证目录，不用 `rm`（删除用 `trash`），不强推，不执行 `git reset --hard`。
- 改完、检查通过后按 AGENTS.md 第 7 节提交；推 master 攒成一批再推，不要每做完一步就推（少用 CI，2026-11-12）；脏工作区先报告。
- 多步骤工作保持任务状态，但不得扩大 AGENTS.md 定义的产品边界。
- 动灯光、MA2、MTC 或播放之前，先读 `docs/LIGHTING_WORKFLOW.md`。
- 用户新定的长期规则，在同一次工作里写进 AGENTS.md 或对应文档，不只留在对话里。

## 不同运行环境

- **Mac 上的 Claude Code**：自动权限模式会拦推 master、`pnpm release:relay`、改 DNS、证书续期和生产部署，需要用户在对话里逐项原话确认（“都确认”放行不了）。Mac 检出里的 `.claude/settings.local.json`（不进仓库）已允许 `Bash(pnpm release:relay)`，只在会话开在本仓库目录时生效。
- **云端会话（claude.ai/code）**：没有 SSH 凭据，连不上服务器和工位电脑，需要 SSH 的事要在用户 Mac 上做；推 tag 会被代理拦，发版用 GitHub API 触发 Release Windows；连不上 `updates.` 更新源，要读线上 `latest.yml` 就放进 GitHub Actions 里跑。在 Linux 上跑测试的办法见 AGENTS.md 第 6 节。
