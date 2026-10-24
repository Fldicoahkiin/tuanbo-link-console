# README 里的链路图

`*.mmd` 是 Mermaid 源码，`*-light.svg`、`*-dark.svg` 是用 [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) 1.1.3 的 `github-light`、`github-dark` 主题渲染出来的图，README 用 `<picture>` 按系统深浅色切换。

改图时只改 `.mmd`，再重新渲染两份 SVG，一起提交。beautiful-mermaid 不是仓库依赖，在仓库外的临时目录里装：

```sh
mkdir -p /tmp/bm && cd /tmp/bm && npm init -y >/dev/null && npm i beautiful-mermaid@1.1.3
cat > render.mjs <<'JS'
import { renderMermaidSVG, THEMES } from 'beautiful-mermaid';
import { readFileSync, writeFileSync } from 'node:fs';
const [input, output, theme] = process.argv.slice(2);
// 去掉外链字体（GitHub 以图片显示 SVG 时不会加载），换成带中文字体的回退列表。
const svg = renderMermaidSVG(readFileSync(input, 'utf8'), THEMES[theme])
  .replace(/@import url\([^)]*\);\n/, '')
  .replace("text { font-family: 'Inter', system-ui, sans-serif; }",
    'text { font-family: Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }');
writeFileSync(output, svg);
JS
for name in windows-release relay-run service-deploy credentials; do
  for theme in light dark; do node render.mjs <仓库>/docs/diagrams/$name.mmd <仓库>/docs/diagrams/$name-$theme.svg github-$theme; done
done
```

beautiful-mermaid 不支持平行四边形等少数形状，用方框代替。
