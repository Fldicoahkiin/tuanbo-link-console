# 更新日志的来源

每个正式版本一份 `X.Y.Z.md`，这里是唯一手写更新日志的地方。下面四处都从这些文件生成，不要另外手写：

| 位置 | 怎么生成 | 显示哪些版本 | 什么时候变 |
| --- | --- | --- | --- |
| GitHub Release 正文 | 推 tag 后云端打包时，`scripts/draft-github-release.mjs` 读这一版的文件建草稿，后面加固定的激活说明 | 这一版 | 建草稿时；草稿已存在就不改 |
| 仓库 [CHANGELOG.md](../CHANGELOG.md) | `pnpm changelog` | 全部；比 `package.json` 版本新的标「未发布」 | 改了这里的文件、或者改了版本号之后运行，和改动一起提交 |
| 官网下载页「更新日志」 | 官网构建时读取（`apps/licensing-server/build-web.mjs`） | 不高于 `apps/licensing-server/web/release.json` 的版本 | 推 master 后官网自动部署；新版上线后更新 `release.json`，新版条目随之出现 |
| 软件「设置 › 外观与更新 › 软件更新」 | 桌面构建时打进安装包（`apps/desktop/electron.vite.config.ts`） | 不高于这个安装包版本的版本；有新版本时给出官网下载页的链接 | 随安装包发布 |

所以下一版的条目可以提前写好：它在官网和软件里都不会提前出现。

## 平时

- 合进 master 的、用户能感觉到的改动，在同一个提交里给下一版的文件加一条（还没有就新建 `X.Y.Z.md`），再运行 `pnpm changelog`。
- 只写用户看得到的变化，用用户的话说清楚「现在会怎样」。服务器、发版工具、测试和文档的改动不写。
- 一条一个主题：`- **主题**：说明。`

## 写法

只支持这几种，别的写法在构建、测试和发版时都会被拒绝，并报出文件和行号：

- 一行一段，段落之间空一行；
- `## ` 小标题；
- 一行一个 `- ` 列表项；
- `**加粗**`。

链接、代码、图片、HTML、反斜杠、单个星号和多行段落都不支持，因为官网和软件要用同样的方式显示。

## 发版

1. 确认这一版的 `X.Y.Z.md` 写全了。
2. 改根目录和 `apps/desktop` 两个 `package.json` 的版本号，运行 `pnpm changelog`（去掉这一版的「未发布」），一起提交 `chore(release): X.Y.Z`，推 master。
3. CI 通过后在 GitHub Actions 手动运行 Release Windows（分支选 master，填这个提交号），工作流自己打 `vX.Y.Z` tag；推 tag 也可以。没有这一版的文件时，`pnpm verify` 和 Release Windows 的第一步都会报错；`CHANGELOG.md` 没更新时，推 master 后的 CI 会报错。所以一定等 CI 通过再发版。打包失败、没发布出去的版本，修好后再触发一次，tag 会挪到修复提交上，版本号不变，详见 [docs/RELEASE_CHAIN.md](../docs/RELEASE_CHAIN.md#以后发版本的标准流程)。
4. 新版上线后更新官网的 `release.json`（`node scripts/write-website-release.mjs`），官网下载页随之显示新版条目。

0.5.1 打了 tag，但构建上传失败、从未发布，改动随 0.5.2 发布，所以没有 `0.5.1.md`。0.4.27 及更早的测试版本只在 GitHub Releases 里有说明。
