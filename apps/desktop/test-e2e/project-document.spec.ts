import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';

test('真实工程 Worker 与文本桥拒绝损坏及未来格式，失败不覆盖原文件', async ({}, info) => {
  const valid = JSON.stringify(createEmptyLinkProject('工程读写边界'));
  const path = info.outputPath('valid.tblink'), corrupt = info.outputPath('corrupt.tblink'), future = info.outputPath('future.tblink');
  const futureContent = JSON.stringify({ ...JSON.parse(valid), schemaVersion: 99 });
  await writeFile(path, valid); await writeFile(corrupt, '{broken'); await writeFile(future, futureContent);
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow();
  try {
    await page.waitForFunction(() => Boolean(window.tbLink));
    const opened = await page.evaluate(path => window.tbLink.openProjectDocument(path), path);
    expect(parseLinkProject(JSON.parse(opened.content)).name).toBe('工程读写边界');
    for (const invalid of [corrupt, future]) {
      const before = await readFile(invalid, 'utf8');
      await expect(page.evaluate(path => window.tbLink.openProjectDocument(path), invalid)).rejects.toThrow();
      expect(await readFile(invalid, 'utf8')).toBe(before);
    }
    await expect(page.evaluate(({ path, content }) => window.tbLink.saveProjectDocument(path, content), { path, content: futureContent })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(valid);
    const reopened = await page.evaluate(path => window.tbLink.openProjectDocument(path), path);
    expect(parseLinkProject(JSON.parse(reopened.content))).toEqual(parseLinkProject(JSON.parse(valid)));
    const revisions = Array.from({ length: 20 }, (_, index) => index === 10 ? futureContent : JSON.stringify({ ...JSON.parse(valid), name: `保存修订 ${index}` }));
    const results = await page.evaluate(async ({ path, revisions }) => (await Promise.allSettled(revisions.map(content => window.tbLink.saveProjectDocument(path, content)))).map(result => result.status), { path, revisions });
    expect(results.filter(result => result === 'rejected')).toHaveLength(1);
    expect(results[10]).toBe('rejected');
    expect(parseLinkProject(JSON.parse(await readFile(path, 'utf8'))).name).toBe('保存修订 19');
  } finally { await app.close(); }
});
