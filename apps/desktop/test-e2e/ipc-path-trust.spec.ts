import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';
import { closeDiscarding } from './save-questions';

const launch = (profile: string): Promise<ElectronApplication> =>
  electron.launch({ args: [`--user-data-dir=${profile}`, join(process.cwd(), 'out/main/index.cjs')] });

type Values = { shown: string; never: string; planted: string; outsideAudio: string; plantedProgram: string; onpc: string; content: string; profile: ReturnType<typeof createDefaultIntegrationProfile> };

/** One request through the real preload bridge, inside the window: its error text, or UNEXPECTED_SUCCESS. */
async function attempt(page: Page, request: (values: Values) => Promise<unknown>, values: Values): Promise<string> {
  try { return `UNEXPECTED_SUCCESS ${JSON.stringify(await page.evaluate(request, values))}`; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

// A compromised window calls the real preload bridge with paths of its own choosing.
test('窗口不能自行指定路径：工程、工程内文件、导入来源和程序位置只认主进程确认过的', async ({}, info) => {
  const shown = info.outputPath('shown/展示工程.tblink'), never = info.outputPath('never/从未打开.tblink'), planted = info.outputPath('planted/写入目标.tblink');
  const outsideAudio = info.outputPath('outside/未选择的音频.wav'), plantedProgram = info.outputPath('outside/伪造程序.exe');
  // Shaped like an onPC data directory: the plugin exchange writes its requests into temp.
  const onpc = info.outputPath('outside/gma2_V_3.3.4');
  for (const part of ['temp', 'plugins', 'importexport']) await mkdir(join(onpc, part), { recursive: true });
  const content = JSON.stringify(createEmptyLinkProject('路径信任验收'));
  for (const file of [shown, never, planted, outsideAudio]) await mkdir(dirname(file), { recursive: true });
  await writeFile(shown, content); await writeFile(never, content);
  await writeFile(join(dirname(shown), 'secret.txt'), 'shown folder secret');
  await mkdir(join(dirname(never), 'assets', 'reference-media'), { recursive: true });
  await writeFile(join(dirname(never), 'assets', 'reference-media', 'secret.png'), 'never folder secret');
  await writeFile(outsideAudio, 'RIFF not chosen by the operator'); await writeFile(plantedProgram, 'MZ');
  const values: Values = { shown, never, planted, outsideAudio, plantedProgram, onpc, content, profile: createDefaultIntegrationProfile() };

  let app = await launch(info.outputPath('profile'));
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '打开工程', exact: true }).waitFor();
    const projects = {
      report: await attempt(page, v => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: v.never, projectId: null }), values),
      open: await attempt(page, v => window.tbLink.openProjectDocument(v.never), values),
      save: await attempt(page, v => window.tbLink.saveProjectDocument(v.planted, v.content), values),
      recovery: await attempt(page, v => window.tbLink.writeRecoveryCopy({ version: 1, projectPath: v.never, projectId: 'planted', name: '伪造', sessionId: crypto.randomUUID(), revision: 1, content: v.content }), values),
      probe: await attempt(page, v => window.tbLink.findMissingAssetFiles({ projectPath: v.never, files: [{ relativePath: 'assets/reference-media/secret.png', sha256: 'a'.repeat(64) }] }), values)
    };
    expect.soft(projects).toEqual({
      report: expect.stringContaining('未经本软件的打开或保存对话框确认'),
      open: expect.stringContaining('未经本软件的打开或保存对话框确认'),
      save: expect.stringContaining('只能访问当前打开的工程'),
      recovery: expect.stringContaining('未经本软件的打开或保存对话框确认'),
      probe: expect.stringContaining('只能访问当前打开的工程')
    });
    expect.soft(await readdir(dirname(planted))).toEqual([]);

    // The project the open dialog returned, once the window shows it.
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, shown);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.locator('.p1-project-ribbon')).toHaveAttribute('title', shown);
    await expect.poll(() => attempt(page, v => window.tbLink.findMissingAssetFiles({ projectPath: v.shown, files: [{ relativePath: 'assets/reference-audio/a.wav', sha256: 'a'.repeat(64) }] }), values))
      .toBe('UNEXPECTED_SUCCESS ["assets/reference-audio/a.wav"]');

    const files = {
      readFolderFile: await attempt(page, v => window.tbLink.resolveReferenceAudioUrl({ projectPath: v.shown, relativePath: 'secret.txt' }).then(url => fetch(url)).then(response => response.text()), values),
      readOtherProject: await attempt(page, v => window.tbLink.resolveMediaAssetUrl({ projectPath: v.never, relativePath: 'assets/reference-media/secret.png' }).then(url => fetch(url)).then(response => response.text()), values),
      inspectOtherProject: await attempt(page, v => window.tbLink.inspectMediaAssets({ projectPath: v.never, assets: [{ id: 'secret', relativePath: 'assets/reference-media/secret.png', name: 'secret', sha256: 'a'.repeat(64) }] }), values),
      writeOtherProject: await attempt(page, v => window.tbLink.saveWaveformCache({ projectPath: v.never, sha256: 'b'.repeat(64), peaks: [0] }), values)
    };
    expect.soft(files).toEqual({
      readFolderFile: expect.stringContaining('只能使用 assets/reference-audio 或 assets/reference-media'),
      readOtherProject: expect.stringContaining('只能访问当前打开的工程'),
      inspectOtherProject: expect.stringContaining('只能访问当前打开的工程'),
      writeOtherProject: expect.stringContaining('只能访问当前打开的工程')
    });
    expect.soft(await exists(join(dirname(never), 'cache'))).toBe(false);

    const sources = {
      importUnchosen: await attempt(page, v => window.tbLink.importReferenceAudio({ projectPath: v.shown, sourcePath: v.outsideAudio, durationMs: 1000 }), values),
      plantProgram: await attempt(page, v => window.tbLink.saveIntegrationProfile({ profile: { ...v.profile, obs: { ...v.profile.obs, executablePath: v.plantedProgram } } }), values)
    };
    expect.soft(sources).toEqual({
      importUnchosen: expect.stringContaining('未经本软件的文件选择或拖放确认'),
      plantProgram: expect.stringContaining('程序位置未经本软件的选择对话框或一键识别确认')
    });
    expect.soft(await exists(join(dirname(shown), 'assets'))).toBe(false);

    const devices = {
      ma2DataDirectory: await attempt(page, v => window.tbLink.exchangeMa2({ dataDirectory: v.onpc, target: 1, operation: 'PING', expected: '', desired: '' }), values)
    };
    expect.soft(devices).toEqual({ ma2DataDirectory: expect.stringContaining('本机 onPC 数据目录必须通过“选择”或“一键识别”设置') });
    expect.soft(await readdir(join(onpc, 'temp'))).toEqual([]);

    // The same bridge saves the shown project.
    const renamed = JSON.stringify({ ...JSON.parse(content), name: '已保存到展示工程' });
    expect(await page.evaluate(({ shown, renamed }) => window.tbLink.saveProjectDocument(shown, renamed), { shown, renamed })).toBe(shown);
    expect(parseLinkProject(JSON.parse(await readFile(shown, 'utf8'))).name).toBe('已保存到展示工程');
  } finally { await closeDiscarding(app); }

  // The main process recorded the shown project and reopens it on the next start.
  app = await launch(info.outputPath('profile'));
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.p1-project-ribbon')).toHaveAttribute('title', shown);
  } finally { await closeDiscarding(app); }
});
