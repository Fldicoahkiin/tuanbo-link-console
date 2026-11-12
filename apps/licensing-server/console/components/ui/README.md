# 这个目录是生成的

这里的组件是 [shadcn/ui](https://ui.shadcn.com)（MIT，作者 shadcn）的 Base UI 版、nova 风格，2026-11-12 从 shadcn-ui/ui 仓库的 main 分支生成。

- 不要手改这些文件。要调颜色、圆角、字体，改 `console/styles.css`；要组合出业务用的组件，写在上一层的 `console/components/` 里。
- 加一个组件或跟上游更新：仓库根目录运行 `node scripts/add-console-component.mjs <组件名>`（更新已有的加 `--update`，然后用 `git diff` 看改了什么）。
- 线上不允许页面运行时插样式，会自己插样式的组件（sonner、input-otp）不能加。提示用 `console/components/toaster.tsx`。
- 写法和网上常见的 Radix 版不一样的地方、主题和构建，见 `docs/OPERATIONS_CONSOLE.md` 的「界面和组件库」。
