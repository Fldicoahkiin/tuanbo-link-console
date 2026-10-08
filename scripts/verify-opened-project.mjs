import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { launchPackagedDesktop } from '../tools/obs/beauty/verify-packaged-desktop.mjs';

const [executable, source, output] = process.argv.slice(2);
if (!output) throw new Error('需提供安装程序、原工程和独立验收目录');
const directory = resolve(output); await mkdir(directory);
const original = await readFile(source);
const project = JSON.parse(original.toString('utf8'));
const copiedProject = join(directory, 'opened.tblink');
await writeFile(copiedProject, original);
const files = new Set([...project.rundown.flatMap(item => item.referenceAudio ? [item.referenceAudio.relativePath,
  ...(item.referenceAudio.timeline?.source ? [item.referenceAudio.timeline.source.relativePath] : []),
  ...(item.referenceAudio.timeline?.tracks ?? []).map(track => track.source.relativePath)] : []), ...project.mediaAssets.map(asset => asset.relativePath)]);
const missing = [];
for (const path of files) {
  const from = resolve(dirname(source), path), to = resolve(directory, path);
  const sourceRelative = relative(dirname(resolve(source)), from), targetRelative = relative(directory, to);
  if (isAbsolute(path) || sourceRelative.startsWith('..') || isAbsolute(sourceRelative) || targetRelative.startsWith('..') || isAbsolute(targetRelative)) throw new Error('工程素材路径超出验收复制范围');
  await mkdir(dirname(to), { recursive: true });
  try { await copyFile(from, to); } catch (error) { if (error.code === 'ENOENT') missing.push(path); else throw error; }
}
const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const { chromium, expect } = requireDesktop('@playwright/test');
const errors = [];
for (let launch = 0; launch < 2; launch++) {
  const application = await launchPackagedDesktop({ executable, directory, chromium });
  try {
    const page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    if (launch === 0) {
      await page.waitForFunction(() => Boolean(globalThis.window.tbLink));
      await page.evaluate(path => localStorage.setItem('tblink.last-project-path.v1', path), copiedProject);
      await page.reload();
    }
    const navigation = page.getByRole('navigation', { name: '主要工作区' });
    await expect(page.locator('[data-total-programs]')).toHaveAttribute('data-total-programs', String(project.rundown.length));
    for (let visit = 0; visit < 3; visit++) {
      await navigation.getByRole('button', { name: '编辑器', exact: true }).click();
      await expect(page.locator('.timeline-ruler')).toBeVisible();
      await expect(page.locator('.editor-program-name')).toContainText(project.rundown[0].title);
      await expect(page.locator('.timeline-workbench')).not.toContainText('所需文件或程序不存在');
      await expect(page.getByText('尚未打开工程', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '保存工程', exact: true })).toHaveCount(0);
      if (visit === 2) await page.screenshot({ path: join(directory, `editor-launch-${launch}.png`) });
      await navigation.getByRole('button', { name: '节目单', exact: true }).click();
    }
  } finally { await application.close(); }
}
assert.deepEqual(errors, []);
assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), createHash('sha256').update(original).digest('hex'), '不得改写原工程');
await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ executable, sourceProjectId: project.projectId,
  sourceUnchanged: true, programs: project.rundown.length, editorRoundTrips: 6, fullApplicationRestart: true,
  projectAndSongVisible: true, existingPathNotPresentedAsUnsaved: true, missingSourceAssets: missing, errors }, null, 2));
console.log('实际工程副本：安装程序打开工程、编辑器、切页、完全关闭重开均通过，原工程未改写。');
