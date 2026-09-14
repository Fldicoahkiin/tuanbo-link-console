import { _electron as electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executablePath = process.argv[2];
if (!executablePath) throw new Error('缺少安装版可执行文件路径');
const userData = await mkdtemp(join(tmpdir(), 'tblink-installer-check-'));
const application = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`] });
try {
  const page = await application.firstWindow();
  await page.getByRole('button', { name: '新建工程', exact: true }).waitFor();
  const title = await page.title();
  if (title !== '团播联动台 / Tuanbo Link Console') throw new Error(`安装版标题不正确：${title}`);
  if (!await application.evaluate(({ app }) => app.isPackaged)) throw new Error('不是正式安装产物');
  console.log(title);
} finally {
  await application.close();
}
