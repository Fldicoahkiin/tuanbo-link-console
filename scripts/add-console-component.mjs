// 给运营后台加（或更新）一个 shadcn/ui 组件。
//
// 后台用的是 shadcn/ui 的 Base UI 版、nova 风格。shadcn 自己的命令行要 `@/` 别名和 components.json，这个仓库没有
// （ESLint 按根目录的 tsconfig 检查后台源码，别名解析不了），所以用这个脚本做同一件事：
// 从 shadcn-ui/ui 仓库取组件源码，把 cn-* 占位类名换成 nova 风格的 Tailwind 类，图标占位换成 lucide 图标，import 改成相对路径。
//
// 用法（仓库根目录）：
//   node scripts/add-console-component.mjs <组件名...>            例：node scripts/add-console-component.mjs checkbox switch
//   --update        组件文件已存在时覆盖（默认不覆盖）
//   --ref <提交>    取 shadcn-ui/ui 的哪个分支或提交，默认 main
//   --from <目录>   不联网，从本地目录读：<目录>/ui/<组件名>.tsx 和 <目录>/styles/style-nova.css
// 加完看一眼生成的文件和它引用的其他组件（脚本会列出来），再跑后台的类型检查、lint 和 scripts/verify-console.mjs。
// 线上不允许页面运行时插样式（CSP 是 style-src 'self'）：sonner、input-otp 这类自己插 <style> 的组件不能用。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../apps/licensing-server/console/components/ui/', import.meta.url));
const args = process.argv.slice(2);
const names = [];
let update = false;
let ref = 'main';
let from = '';
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] ?? '';
  if (arg === '--update') update = true;
  else if (arg === '--ref') ref = args[++index] ?? '';
  else if (arg === '--from') from = args[++index] ?? '';
  else if (/^[a-z][a-z0-9-]*$/.test(arg)) names.push(arg);
  else throw new Error(`看不懂的参数：${arg}`);
}
if (names.length === 0 || !ref) throw new Error('用法：node scripts/add-console-component.mjs <组件名...> [--update] [--ref <提交>] [--from <目录>]');

/** 读一个源文件：给了 --from 就读本地，否则从 GitHub 取。 */
async function source(path) {
  if (from) return readFile(join(from, path), 'utf8');
  const url = `https://raw.githubusercontent.com/shadcn-ui/ui/${ref}/apps/v4/registry/${path === 'styles/style-nova.css' ? path : `bases/base/${path}`}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`取不到 ${url}（HTTP ${response.status}）。组件名写对了吗？连不上 GitHub 时先把文件下载到本地，再用 --from。`);
  return response.text();
}

// nova 风格的样式表：每条规则是 `.cn-xxx { @apply 一串 Tailwind 类; }`。
const css = await source('styles/style-nova.css');
const classes = new Map();
for (const match of css.slice(css.indexOf('{') + 1, css.lastIndexOf('}')).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = (match[1] ?? '').replace(/\/\*[^]*?\*\//g, '').trim();
  const apply = /^@apply ([^;]+);$/.exec((match[2] ?? '').replace(/\s+/g, ' ').trim());
  if (/^\.cn-[\w-]+$/.test(selector)) classes.set(selector.slice(1), apply?.[1]?.trim() ?? '');
}
// 后台不用毛玻璃：菜单的半透明效果去掉，遮罩直接压暗。
for (const translucent of ['cn-menu-translucent', 'cn-menu-translucent-aria']) classes.set(translucent, '');
const withoutBlur = tokens => {
  const blurred = tokens.some(token => token.startsWith('supports-backdrop-filter:backdrop-blur'));
  return blurred ? tokens.filter(token => !token.startsWith('supports-backdrop-filter:backdrop-blur')).map(token => (token === 'bg-black/10' ? 'bg-black/40' : token)) : tokens;
};

await mkdir(output, { recursive: true });
for (const name of names) {
  const target = join(output, `${name}.tsx`);
  if (existsSync(target) && !update) throw new Error(`${name}.tsx 已经有了。要按 shadcn 的最新源码重新生成，加 --update（之后用 git diff 看改了什么）。`);
  let text = (await source(`ui/${name}.tsx`)).replace(/^"use client"\n+/, '');
  const icons = new Set();
  text = text.replace(/<IconPlaceholder\s+([^]*?)\/>/g, (_whole, props) => {
    const icon = /lucide="(\w+)"/.exec(props)?.[1];
    if (!icon) throw new Error(`${name}：图标占位没有 lucide 的名字`);
    icons.add(icon);
    const rest = props.replace(/\b(lucide|tabler|hugeicons|phosphor|remixicon)="\w+"\s*/g, '').replace(/\s+/g, ' ').trim();
    return `<${icon}${rest ? ` ${rest}` : ''} />`;
  });
  text = text.replace(/^import \{ IconPlaceholder \} from .*\n/m, icons.size ? `import { ${[...icons].sort().join(', ')} } from "lucide-react"\n` : '');
  text = text
    .replace(/from "cn"/g, 'from "../../lib/utils"')
    .replace(/from "@\/registry\/bases\/base\/ui\//g, 'from "./')
    .replace(/from "@\/registry\/bases\/base\/(hooks|lib)\//g, 'from "../../$1/');
  const unknown = new Set();
  text = text.replace(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g, (whole, quote, value) => {
    if (!/\bcn-[a-z]/.test(value)) return whole;
    const tokens = value.split(/\s+/).filter(Boolean).flatMap(token => {
      if (!/^cn-[a-z0-9-]+$/.test(token)) return [token];
      const expanded = classes.get(token);
      if (expanded === undefined) unknown.add(token);
      return expanded ? expanded.split(/\s+/) : [];
    });
    return quote + [...new Set(withoutBlur(tokens))].join(' ') + quote;
  });
  await writeFile(target, text);
  const needs = [...new Set([...text.matchAll(/from "([^"]+)"/g)].map(match => match[1] ?? ''))].filter(value => value.startsWith('.') && value !== '../../lib/utils');
  const missing = needs.filter(value => !existsSync(join(output, `${value}.tsx`)) && !existsSync(join(output, `${value}.ts`)));
  console.log(`${name}.tsx 已生成${missing.length ? `；它还要这些文件，仓库里还没有：${missing.join('、')}` : ''}${unknown.size ? `；nova 风格里没有这些占位类，已去掉：${[...unknown].join('、')}` : ''}`);
}
