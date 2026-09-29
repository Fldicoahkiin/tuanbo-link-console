# 标题字体

Noto Sans SC，SIL Open Font License 1.1。官网标题使用自托管 WOFF2 子集，正文保留系统中文字体。

来源：https://github.com/google/fonts/tree/main/ofl/notosanssc

原始 TTF SHA256：`a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`

构建：`pyftsubset NotoSansSC[wght].ttf --text-file=apps/licensing-server/web/index.html --flavor=woff2 --output-file=apps/licensing-server/web/assets/display.woff2 --layout-features='*'`。修改标题文字时需重新生成子集；不在子集内的文字使用声明的中文后备字体。许可原文保留在 FONT-LICENSE.txt。
