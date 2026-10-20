import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron, type TestInfo } from '@playwright/test';
import {
  createEmptyLinkProject, createLightingDocument, parseLinkProject,
  type Ma2ExecutorInput, type Ma2ExecutorPage, type Ma2ExecutorPageRequest,
  type Ma2ExecutorUpdateRequest, type Ma2ExecutorUpdateResult
} from '@tb/schema';

export async function launchExecutorFixture(info: TestInfo) {
  const source = { show: '三层执行器验收', generation: 'executor-fixture', version: '3.7.0.5' };
  const names = ['xws', 'Sequ', '定点', '蓝色', '轮廓', '前区', '双色', '面光_Long_Sequence_Name', '摇头', '收光'];
  const sequences = names.map((name, index) => ({
    sequence: index + 79, name,
    cues: Array.from({ length: index === 2 ? 4 : 1 }, (_, step) => ({
      index: step + 1, number: `${step + 1}.000`,
      name: index === 2 ? ['入场', '定点', '移动', '收光'][step]! : name
    }))
  }));
  const item = (slot: number, index: number, width = 1): Ma2ExecutorPage['items'][number] => ({
    slot, width, name: sequences[index]!.name, sequence: sequences[index]!.sequence,
    kind: 'sequence', button: 12299, buttons: [12299, 12302, 12290, 0], reference: ['25', '1', String(sequences[index]!.sequence)],
    revision: String(index + 1).padStart(64, '0'), color: ['#e2576c', '#d5ad47', '#74abc4'][index % 3],
    priority: 'LTP', softLtp: false, fader: 0
  });
  const pages: Record<number, Ma2ExecutorPage> = Object.fromEntries([
    { page: 4, name: '常用灯光', items: [item(101, 0), item(102, 1), item(103, 2, 2), item(106, 3), item(116, 4), item(131, 5), item(176, 6), item(219, 5)] },
    { page: 5, name: '演出灯光', items: [item(101, 3), item(115, 6)] },
    { page: 100, name: '现场执行器', items: [item(1, 7), item(2, 8), item(15, 9), item(16, 4), item(101, 8), item(102, 9)] },
    { page: 101, name: '备用执行器', items: [item(1, 6), item(101, 7)] },
    { page: 1000, name: '歌曲编排', items: [item(101, 0)] }
  ].map(value => [value.page, { ...value, source, readAt: new Date().toISOString(), sequences }]));
  const library = {
    directory: { ...source, entries: sequences.map(value => ({ target: value.sequence, name: value.name })) },
    readAt: new Date().toISOString(), sequences, fixtureUsage: [], errors: []
  };
  const project = createEmptyLinkProject('三层执行器验收'); project.schemaVersion = 2;
  project.rundown = [{ id: 'song', title: '灯光编排验收', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() }];
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library };
  const file = info.outputPath('executor.tblink'); await writeFile(file, JSON.stringify(parseLinkProject(project)));
  const app = await electron.launch({
    args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')],
    env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' }
  });
  const page = await app.firstWindow();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ ipcMain, dialog, BrowserWindow }, { file, source, pages, library }) => {
    BrowserWindow.getAllWindows()[0]!.setSize(1600, 1000);
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
    process.env.TBLINK_EXECUTOR_ACTIONS = '[]';
    process.env.TBLINK_EXECUTOR_INPUTS = '[]';
    process.env.TBLINK_EXECUTOR_RELEASES = '0';
    process.env.TBLINK_EXECUTOR_UPDATES = '[]';
    process.env.TBLINK_EXECUTOR_READS = '[]';
    process.env.TBLINK_EXECUTOR_LIVE_CALLS = '0';
    const append = (key: string, value: unknown): void => {
      const values = JSON.parse(process.env[key] ?? '[]') as unknown[];
      values.push(value); process.env[key] = JSON.stringify(values);
    };
    const replace = (name: string, handler: Parameters<typeof ipcMain.handle>[1]): void => {
      ipcMain.removeHandler(name); ipcMain.handle(name, handler);
    };
    const snapshot = (number: number): Ma2ExecutorPage => structuredClone(pages[number]
      ?? { page: number, name: '', source, readAt: new Date().toISOString(), sequences: [], items: [] });
    replace('link:ma2-network-status', () => ({
      settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false },
      state: 'connected', version: '3.7.0.5', passwordSaved: false, error: null
    }));
    replace('link:ma2-executor-pages', () => ({
      ...source, buttonPage: 4, faderPage: 100,
      pages: Object.values(pages).map(value => ({ page: value.page, name: value.name }))
    }));
    replace('link:ma2-executor-page', (_event, request: Ma2ExecutorPageRequest): Ma2ExecutorPage => {
      append('TBLINK_EXECUTOR_READS', request.page);
      if (process.env.TBLINK_EXECUTOR_READ_FAILURE === String(request.page)) throw new Error('验收：此页暂未读回');
      const value = snapshot(request.page);
      if (process.env.TBLINK_EXECUTOR_DENSE && (request.page === 4 || request.page === 100)) {
        const shortNames = ['面光', 'xws', '定点', '蓝色', '轮廓', '前区', '双色', '跟随长名称的灯光效果', '摇头', '收光'];
        value.sequences = value.sequences.map((sequence, index) => ({
          ...sequence, name: shortNames[index]!,
          cues: Array.from({ length: [1, 4, 8, 2, 1][index % 5]! }, (_, cueIndex) => ({ index: cueIndex + 1, number: `${cueIndex + 1}.000`, name: `段落 ${cueIndex + 1}` }))
        }));
        const slots = request.page === 4 ? Array.from({ length: 90 }, (_, i) => i + 101) : [...Array.from({ length: 15 }, (_, i) => i + 1), ...Array.from({ length: 15 }, (_, i) => i + 101)];
        const template = value.items[0]!;
        value.items = slots.filter((_slot, index) => index % 5 !== 4).map((slot, index) => {
          const sequence = value.sequences[index % value.sequences.length]!;
          return { ...template, slot, width: 1, sequence: sequence.sequence, name: sequence.name ?? '', reference: ['25', '1', String(sequence.sequence)],
            color: ['#b57c84', '#b9a56b', '#70a0b5', '#779b80'][index % 4], buttons: [12307, 12302, 12290, 0], button: 12307 };
        });
      }
      if (process.env.TBLINK_EXECUTOR_REMOTE_NAME && request.page === 100 && value.items[0]) {
        value.items[0].name = process.env.TBLINK_EXECUTOR_REMOTE_NAME;
      }
      return value;
    });
    replace('link:ma2-executor-update', async (_event, request: Ma2ExecutorUpdateRequest): Promise<Ma2ExecutorUpdateResult> => {
      append('TBLINK_EXECUTOR_UPDATES', request);
      const deadline = Date.now() + 10000;
      while (process.env.TBLINK_EXECUTOR_HOLD_UPDATE) {
        if (Date.now() > deadline) throw new Error('验收：写入回读等待超时');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await new Promise(resolve => setTimeout(resolve, 180));
      if (process.env.TBLINK_EXECUTOR_UPDATE_FAILURE) throw new Error('验收：写入未确认');
      const current = pages[request.page];
      const found = current?.items.find(value => value.slot === request.slot);
      if (!current || !found) throw new Error('验收：源格子已经变化');
      const touched = [request.page];
      if (request.action.kind === 'move') {
        const action = request.action;
        const destination = pages[action.page] ?? { page: action.page, name: '', source, readAt: new Date().toISOString(), sequences: current.sequences, items: [] };
        if (destination.items.some(value => value.slot < action.slot + found.width && value.slot + value.width > action.slot)) throw new Error('验收：目标格子已占用');
        current.items = current.items.filter(value => value.slot !== request.slot);
        destination.items.push({ ...found, slot: action.slot });
        pages[action.page] = destination;
        if (action.page !== request.page) touched.push(action.page);
      } else if (request.action.kind === 'rename') {
        found.name = request.action.name;
        for (const sequence of library.sequences) if (sequence.sequence === found.sequence) sequence.name = request.action.name;
      } else current.items = current.items.filter(value => value.slot !== request.slot);
      process.env.TBLINK_EXECUTOR_SERVER_PAGES = JSON.stringify(pages);
      return { pages: touched.map(snapshot), backupFile: 'C:/executor-acceptance-backup.xml' };
    });
    replace('link:ma2-effect-library', () => library);
    replace('link:ma2-audition-play', (_event, payload: unknown) => { append('TBLINK_EXECUTOR_ACTIONS', payload); });
    replace('link:ma2-executor-input', (_event, payload: Ma2ExecutorInput) => { append('TBLINK_EXECUTOR_INPUTS', payload); });
    replace('link:ma2-executor-release', () => { process.env.TBLINK_EXECUTOR_RELEASES = String(Number(process.env.TBLINK_EXECUTOR_RELEASES) + 1); });
    for (const channel of ['link:ma2-live-read', 'link:ma2-live-input']) replace(channel, () => {
      process.env.TBLINK_EXECUTOR_LIVE_CALLS = String(Number(process.env.TBLINK_EXECUTOR_LIVE_CALLS) + 1);
      throw new Error('三层页面不得建立额外推杆连接');
    });
  }, { file, source, pages, library });
  await page.evaluate(() => {
    localStorage.setItem('tblink.ma2-connection-method.v1', 'network');
    localStorage.setItem('tblink.ma2-realtime-enabled.v1', 'false');
  });
  await page.reload();
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
  const pool = page.getByRole('region', { name: 'MA2 序列预览' });
  await pool.getByRole('button', { name: '控台页面', exact: true }).click();
  return { app, page, pool, errors };
}
