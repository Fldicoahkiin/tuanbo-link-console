import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, _electron as electron } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type Ma2AuditionRequest, type Ma2AuditionState, type Ma2CatalogRequest, type Ma2RenameRequest } from '@tb/schema';
import { toConsoleLabel } from '@tb/core/link';
import { answerSaveQuestions, savedValue } from './save-questions';

test('界面样本：单步分类点击出灯，多步进入原编号子菜单，移除冗余按钮', async ({}, info) => {
  const project = createEmptyLinkProject('灯光素材分类界面样本');
  project.schemaVersion = 2;
  const lighting = createLightingDocument();
  lighting.ma2Library = { show: '界面布局样本（非现场读取）', readAt: '2026-09-26T00:00:00.000Z', sequences: Array.from({ length: 1000 }, (_, index) => ({ sequence: index + 1, name: index % 2 ? `原名称 dance-${index + 1}` : `单步灯光 ${index + 1}`, cues: Array.from({ length: index % 2 ? 8 : 1 }, (_, step) => ({ index: step, number: `${step + 1}.000`, name: step===0 ? '控台原名－前区面光暖白完整名称' : `原步骤 ${step + 1}` })) })) };
  const directory = { show: lighting.ma2Library.show, generation: 'test', version: '3.7.0.5', entries: lighting.ma2Library.sequences.map(sequence => ({ target: sequence.sequence, name: sequence.name ?? '' })) };
  project.ma2MaterialLibrary={version:1,source:'192.0.2.1:30000',library:{directory,readAt:lighting.ma2Library.readAt,sequences:lighting.ma2Library.sequences,fixtureUsage:[],errors:[]}};
  const audio=Buffer.alloc(44+48000*10*2);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(48000,24);audio.writeUInt32LE(96000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(audio.length-44,40);await writeFile(info.outputPath('audio.wav'),audio);
  project.rundown = [{ id: 'sample', title: '界面样本节目', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting,referenceAudio:{assetId:'test-audio',relativePath:'audio.wav',durationMs:10000,sha256:createHash('sha256').update(audio).digest('hex')} }];
  const file = info.outputPath('library.tblink');
  await writeFile(file, JSON.stringify(parseLinkProject(project)));
  const executable = process.env.TBLINK_MA2_PACKAGED_EXE;
  const application = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...executable ? [] : [process.env.TBLINK_MA2_TEST_MAIN ?? join(process.cwd(), 'out/main/index.cjs')]] });
  const page = await application.firstWindow();
  await answerSaveQuestions(application);
  page.on('pageerror', error => console.error('界面运行错误', error.message));
  try {
    // The main process writes renamed Chinese labels as pinyin; this stand-in console reads them back the same way.
    const labels = Object.fromEntries(['前区暖白', '分类暖白', '控台原名－前区面光暖白完整名称'].map(name => [name, toConsoleLabel(name)]));
    await application.evaluate(({ ipcMain, dialog }, { path, directory, labels }) => {
      process.env.TBLINK_LIBRARY_CALLS = '[]';
      process.env.TBLINK_RENAME_CALLS = '[]';
      // This test owns rename history; background music analysis is a separate workflow.
      ipcMain.removeHandler('link:automatic-music-status');
      ipcMain.handle('link:automatic-music-status', () => ({ version: 1, available: false, device: 'cpu', devices: ['cpu'], reason: '素材交互验收不运行音乐分析', publication: 'not-validated', jobs: [] }));
      ipcMain.removeHandler('link:ma2-catalog');
      ipcMain.handle('link:ma2-catalog', () => ({ directory: { show: '界面布局样本（非现场读取）', generation: 'test', version: '3.7.0.5', entries: [] }, readAt: new Date().toISOString(), entries: [] }));
      ipcMain.removeHandler('link:ma2-effect-library');
      ipcMain.handle('link:ma2-effect-library', (_event, request: Ma2CatalogRequest) => {
        if (request.targets?.length !== 0) throw new Error('缓存素材交互不应重新扫描完整素材');
        return { directory, readAt: new Date().toISOString(), sequences: [], fixtureUsage: [], errors: [] };
      });
      ipcMain.removeHandler('link:ma2-rename');
      ipcMain.handle('link:ma2-rename', (_event, input: Ma2RenameRequest) => {
        const calls = JSON.parse(process.env.TBLINK_RENAME_CALLS ?? '[]') as unknown[];
        calls.push(input); process.env.TBLINK_RENAME_CALLS = JSON.stringify(calls);
        return { sequence: input.change.sequence, cue: input.change.cue, kind: input.change.kind, show: input.change.show, generation: input.generation, name: labels[input.change.name] ?? input.change.name, backupFile: `tblink_label_${'a'.repeat(32)}.xml` };
      });
      ipcMain.removeHandler('link:ma2-network-status');
      ipcMain.handle('link:ma2-network-status', () => ({ settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, state: 'connected', version: '3.7.0.5', passwordSaved: false, error: null }));
      ipcMain.removeHandler('link:ma2-play-cue');
      let audition:Ma2AuditionState={version:1,revision:0,generation:0,phase:'idle',targets:[]};
      ipcMain.removeHandler('link:ma2-audition-play');ipcMain.handle('link:ma2-audition-play',(_event,input:Ma2AuditionRequest)=>{const calls=JSON.parse(process.env.TBLINK_LIBRARY_CALLS??'[]') as unknown[];calls.push(input);process.env.TBLINK_LIBRARY_CALLS=JSON.stringify(calls);const action=input.action.target==='sequence'?{target:'sequence' as const,sequence:input.action.sequence,action:'off' as const}:{target:'executor' as const,executor:input.action.executor,action:'off' as const};const id=JSON.stringify(action);audition={...audition,revision:audition.revision+1,phase:'active',targets:[...audition.targets.filter(t=>t.id!==id),{id,network:input.network,action,state:'sent',error:null}]};_event.sender.send('link:ma2-audition-state',audition);});
      ipcMain.removeHandler('link:ma2-audition-control');ipcMain.handle('link:ma2-audition-control',(_event,input:{action:string})=>{if(input.action==='stop'){const calls=JSON.parse(process.env.TBLINK_LIBRARY_CALLS??'[]') as unknown[];calls.push(...audition.targets.map(target=>({action:target.action})));process.env.TBLINK_LIBRARY_CALLS=JSON.stringify(calls);audition={...audition,generation:audition.generation+1,revision:audition.revision+1,phase:'sent',targets:[]};_event.sender.send('link:ma2-audition-state',audition);}return audition;});
      ipcMain.handle('link:ma2-play-cue', (_event, payload: unknown) => { const calls = JSON.parse(process.env.TBLINK_LIBRARY_CALLS ?? '[]') as unknown[]; calls.push(payload); process.env.TBLINK_LIBRARY_CALLS = JSON.stringify(calls); });
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, { path: file, directory, labels });
    await page.evaluate(() => localStorage.setItem('tblink.ma2-connection-method.v1', 'network'));
    await page.reload();
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    // Pausing keeps local editing available but queues every console write.
    const realtime = page.getByRole('switch', { name: '实时同步', exact: true });
    await expect(realtime).toBeChecked();
    await realtime.click();
    await expect(realtime).not.toBeChecked();
    await page.getByRole('navigation',{name:'灯光素材主菜单'}).getByRole('button',{name:/控台/}).click();
    const preview = page.getByRole('region', { name: 'MA2 序列预览' });
    const pool = preview.locator('[aria-label="素材序列"]');
    await expect(pool).toHaveAttribute('data-total-cues','4500');
    await preview.getByRole('button',{name:'全部',exact:true}).click();
    await expect(pool).toHaveAttribute('data-total-cues', '1000');
    const virtual = await pool.evaluate(element => {
      const cells = [...element.querySelectorAll<HTMLElement>('[data-cue-cell]')];
      const first = cells[0]!.getBoundingClientRect();
      const columns = cells.filter(cell => cell.getBoundingClientRect().y === first.y).length;
      return { count: cells.length, rows: Math.ceil(element.clientHeight / first.height), columns, total: Number(element.getAttribute('data-total-cues')) };
    });
    expect(virtual.count).toBeGreaterThan(0);
    expect(virtual.count).toBeLessThanOrEqual((virtual.rows + 4) * virtual.columns + 1);
    expect(virtual.count).toBeLessThan(virtual.total);
    await expect(page.getByLabel('灯光输出方式', { exact: true })).toBeVisible();
    await expect(page.getByLabel('灯光输出方式', { exact: true })).toHaveValue('timecode');
    await page.getByLabel('灯光输出方式', { exact: true }).selectOption('network');
    await expect(page.getByLabel('灯光输出方式', { exact: true })).toHaveValue('network');
    await page.getByLabel('灯光输出方式', { exact: true }).selectOption('timecode');
    await preview.getByRole('textbox', { name: '搜索序列或 Cue' }).fill('dance-1000');
    await expect(pool).toHaveAttribute('data-total-cues', '1');
    await preview.getByRole('textbox', { name: '搜索序列或 Cue' }).fill('');
    await pool.getByRole('button').first().focus(); await page.keyboard.press('End');
    await expect(pool.getByRole('button', { name: /1000/ })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(pool.getByRole('button').first()).toBeFocused();
    await page.screenshot({ path: info.outputPath('classified-pool.png') });
    await preview.getByRole('button', { name: '单步', exact: true }).click();
    await expect(pool).toHaveAttribute('data-total-cues', '4500');
    await expect(pool.getByRole('button',{name:'试听序列 2 灯光步 3.000',exact:true})).toBeVisible();
    await expect(pool.getByRole('button').first().locator('strong')).toHaveText('控台原名－前区面光暖白完整名称');
    await pool.getByRole('button').first().click();
    await expect.poll(async () => (JSON.parse(await application.evaluate(() => process.env.TBLINK_LIBRARY_CALLS ?? '[]')) as unknown[]).length).toBe(1);
    await preview.getByRole('button', { name: '多步', exact: true }).click();
    await expect(pool).toHaveAttribute('data-total-cues', '500');
    await pool.getByRole('button').first().click();
    expect(JSON.parse(await application.evaluate(() => process.env.TBLINK_LIBRARY_CALLS ?? '[]')) as unknown[]).toHaveLength(1);
    await expect(preview.locator('strong[title="2 · 原名称 dance-2"]')).toBeVisible();
    await expect(preview.locator('.ma2-pool-navigation>strong')).toHaveText('原名称 dance-2');
    expect(await preview.locator('.ma2-pool-navigation').evaluate(element=>element.parentElement?.classList.contains('ma2-material-menubar'))).toBe(true);
    await expect(preview.locator('.cue-pool-grid button')).toHaveCount(8);
    await preview.getByRole('button', { name: '试听灯光步 3.000', exact: true }).click();
    await expect.poll(async () => (JSON.parse(await application.evaluate(() => process.env.TBLINK_LIBRARY_CALLS ?? '[]')) as unknown[]).length).toBe(2);
    for (const name of ['从第一步开始', '继续', '加入编排', '加入分类', '收藏多步序列']) await expect(preview.getByRole('button', { name, exact: true })).toHaveCount(0);
    await preview.getByRole('button',{name:'停止试听',exact:true}).click();
    await expect(preview.getByRole('button',{name:'停止试听',exact:true})).toHaveAttribute('data-phase','sent');
    await expect(preview.getByText('关闭指令已发送',{exact:true})).toHaveCount(0);
    await expect(preview.locator('.cue-pool-grid [aria-pressed=true],.cue-pool-grid [data-picked=true]')).toHaveCount(0);

    const calls = JSON.parse(await application.evaluate(() => process.env.TBLINK_LIBRARY_CALLS ?? '[]')) as { action: unknown }[];
    expect(calls.map(call => call.action)).toEqual([{ target: 'sequence', sequence: 1, action: 'goto', cue: '1.000' }, { target: 'sequence', sequence: 2, action: 'goto', cue: '3.000' },{target:'sequence',sequence:1,action:'off'},{target:'sequence',sequence:2,action:'off'}]);
    await page.screenshot({ path: info.outputPath('multi-step-submenu.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
    const routeBox = await page.getByLabel('灯光输出方式', { exact: true }).boundingBox();
    expect(routeBox).not.toBeNull();
    expect(routeBox!.x + routeBox!.width).toBeLessThan(1280);
    await page.screenshot({ path: info.outputPath('compact-window.png') });
    // Right click never auditions and classification applies at the destination leaf, without a form.
    const beforeClassify=(JSON.parse(await application.evaluate(()=>process.env.TBLINK_LIBRARY_CALLS??'[]')) as unknown[]).length;
    await preview.getByRole('button',{name:'试听灯光步 1.000',exact:true}).click({button:'right'});
    const menu=page.getByRole('dialog',{name:'Cue 右键菜单'});
    await expect(menu).toBeVisible();await page.screenshot({path:info.outputPath('cue-context-menu.png')});
    await menu.getByRole('button',{name:'设置分类',exact:true}).click();
    await expect(menu.locator('[aria-pressed=true]')).toHaveCount(0);await expect(menu.getByRole('button',{name:'确定',exact:true})).toBeDisabled();
    await menu.getByText('面光、轮廓和效果用途',{exact:true}).click();
    await menu.getByRole('button',{name:'面光',exact:true}).click();await menu.getByRole('button',{name:'亮调',exact:true}).click();await menu.getByRole('button',{name:'前区',exact:true}).click();
    await menu.getByRole('button',{name:'归入 面光 亮调 · 3人 · 前区',exact:true}).click();await expect(menu).toBeVisible();await menu.getByRole('button',{name:'确定',exact:true}).click();
    await expect(menu).toHaveCount(0);await expect(page.locator('.classification-editor')).toHaveCount(0);
    expect((JSON.parse(await application.evaluate(()=>process.env.TBLINK_LIBRARY_CALLS??'[]')) as unknown[]).length).toBe(beforeClassify);
    const consoleStep=preview.getByRole('button',{name:'试听灯光步 1.000',exact:true});
    await consoleStep.click({button:'right'});await menu.getByRole('button',{name:'重命名',exact:true}).click();
    await expect(menu.getByRole('textbox',{name:'Cue 名称',exact:true})).toHaveValue('控台原名－前区面光暖白完整名称');
    await menu.getByRole('textbox',{name:'Cue 名称',exact:true}).fill('   ');await expect(menu.getByRole('button',{name:'确定',exact:true})).toBeDisabled();
    await menu.getByRole('textbox',{name:'Cue 名称',exact:true}).fill('前区暖白');
    await page.screenshot({path:info.outputPath('cue-rename.png')});
    await menu.getByRole('textbox',{name:'Cue 名称',exact:true}).press('Enter');
    await expect(consoleStep.locator('strong')).toHaveText('前区暖白');
    const waitRename = async (name: string): Promise<void> => { await expect.poll(async () => (JSON.parse(await application.evaluate(() => process.env.TBLINK_RENAME_CALLS ?? '[]')) as Ma2RenameRequest[]).at(-1)?.change.name).toBe(name); await expect(page.getByRole('button', { name: '同步状态详情', exact: true })).toHaveAttribute('data-state', 'verified'); };
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(file,'utf8'))).ma2MaterialLibrary?.userLibrary?.entries[0]?.name)).toBe('前区暖白');
    expect(JSON.parse(await application.evaluate(() => process.env.TBLINK_RENAME_CALLS ?? '[]')) as Ma2RenameRequest[]).toEqual([]);
    await expect(realtime).not.toBeChecked();
    await realtime.click();
    await expect(realtime).toBeChecked();
    await waitRename('前区暖白');
    await page.keyboard.press('Control+z');await expect(consoleStep.locator('strong')).toHaveText('控台原名－前区面光暖白完整名称');await waitRename('控台原名－前区面光暖白完整名称');
    await page.keyboard.press('Control+y');await expect(consoleStep.locator('strong')).toHaveText('前区暖白');await waitRename('前区暖白');
    await consoleStep.click({button:'right'});await menu.getByRole('button',{name:'重命名',exact:true}).click();
    await expect(menu.getByRole('textbox',{name:'Cue 名称',exact:true})).toHaveValue('前区暖白');
    await menu.getByRole('textbox',{name:'Cue 名称',exact:true}).fill('不会保存');await page.keyboard.press('Escape');
    await expect(consoleStep.locator('strong')).toHaveText('前区暖白');
    expect((JSON.parse(await application.evaluate(()=>process.env.TBLINK_LIBRARY_CALLS??'[]')) as unknown[]).length).toBe(beforeClassify);
    const navigation=page.getByRole('navigation',{name:'灯光素材主菜单'});
    await navigation.getByRole('button',{name:'面光',exact:true}).click();
    const classified=page.locator('[aria-label="分类 Cue"]');
    await expect(classified).toHaveAttribute('data-total-cues','1');
    await expect(classified.locator('.classification-cell>button').first()).toContainText('前区暖白');
    await classified.locator('.classification-cell>button').first().click({button:'right'});
    await menu.getByRole('button',{name:'重命名',exact:true}).click();await menu.getByRole('textbox',{name:'Cue 名称',exact:true}).fill('分类暖白');await menu.getByRole('button',{name:'确定',exact:true}).click();
    await expect(classified.locator('.classification-cell>button').first()).toContainText('分类暖白');
    const syncBadge = page.getByRole('button', { name: '同步状态详情', exact: true });
    await waitRename('分类暖白');
    await expect(realtime).toBeChecked();
    const renameCalls = JSON.parse(await application.evaluate(() => process.env.TBLINK_RENAME_CALLS ?? '[]')) as Ma2RenameRequest[];
    expect(renameCalls.map(call => call.change.name)).toEqual(['前区暖白','控台原名－前区面光暖白完整名称','前区暖白','分类暖白']);
    expect(renameCalls.at(-1)!.change).toMatchObject({ sequence: 2, cue: '1.000', kind: 'single', name: '分类暖白', confirmedName: toConsoleLabel('前区暖白') });
    await realtime.click();
    await expect(realtime).not.toBeChecked();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(classified.locator('.classification-cell>button').first()).toContainText('前区暖白');
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(file,'utf8'))).ma2MaterialLibrary?.userLibrary?.entries[0]?.name)).toBe('前区暖白');
    expect((JSON.parse(await application.evaluate(() => process.env.TBLINK_RENAME_CALLS ?? '[]')) as Ma2RenameRequest[])).toHaveLength(renameCalls.length);
    await realtime.click();
    await expect(realtime).toBeChecked();
    await waitRename('前区暖白');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await waitRename('分类暖白');
    await expect(syncBadge).toHaveAttribute('data-state', 'verified');
    await page.screenshot({ path: info.outputPath('rename-synced.png') });
    await page.getByRole('switch', { name: '实时同步', exact: true }).click();
    await expect(page.locator('.cue-composer')).toHaveCount(0);
    await page.locator('.lighting-playback-settings>summary').click();await page.getByLabel('选中 Cue 实时播放',{exact:true}).uncheck();
    await classified.locator('.classification-cell>button').first().click();
    await expect.poll(async()=>(JSON.parse(await application.evaluate(()=>process.env.TBLINK_LIBRARY_CALLS??'[]')) as unknown[]).length).toBe(beforeClassify+1);
    await expect(menu).toHaveCount(0);await expect(page.locator('.classification-detail')).toHaveCount(0);
    await classified.locator('.classification-cell>button').first().click({button:'right'});
    await menu.getByRole('button',{name:'设置分类',exact:true}).click();await menu.getByText('面光、轮廓和效果用途',{exact:true}).click();
    await expect(menu.getByRole('button',{name:'归入 面光 亮调 · 3人 · 前区',exact:true})).toHaveAttribute('aria-pressed','true');
    await menu.getByRole('button',{name:'轮廓',exact:true}).click();await menu.getByRole('button',{name:'后区',exact:true}).click();
    await menu.getByRole('button',{name:'归入 轮廓 7人 · 后区',exact:true}).click();await menu.getByRole('button',{name:'确定',exact:true}).click();
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(file,'utf8'))).ma2MaterialLibrary?.userLibrary?.entries?.[0]?.categoryIds)).toEqual(['front:bright:3:front','rim:7:back']);
    await classified.locator('.classification-cell>button').first().click({button:'right'});
    await menu.getByRole('button',{name:'移除素材',exact:true}).click();
    await expect(classified.locator('.classification-cell')).toHaveCount(0);
    // Removing a category membership leaves the console catalog and other memberships intact.
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(file,'utf8'))).ma2MaterialLibrary?.userLibrary?.entries?.[0]?.categoryIds)).toEqual(['rim:7:back']);
    await navigation.getByRole('button',{name:/控台/}).click();
    await expect(pool).toHaveAttribute('data-total-cues','4500');
    await pool.getByRole('button',{name:'试听序列 1 灯光步 1.000',exact:true}).click();
    await pool.getByRole('button',{name:'试听序列 2 灯光步 1.000',exact:true}).click({modifiers:['Control']});
    await pool.getByRole('button',{name:'试听序列 2 灯光步 1.000',exact:true}).click({button:'right'});
    await expect(menu).toContainText('已选 2 个 Cue');await menu.getByRole('button',{name:'设置分类',exact:true}).click();await menu.getByText('面光、轮廓和效果用途',{exact:true}).click();await menu.getByRole('button',{name:'效果',exact:true}).click();
    await menu.getByRole('button',{name:'归入 效果 重击',exact:true}).click();await menu.getByRole('button',{name:'确定',exact:true}).click();
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(file,'utf8'))).ma2MaterialLibrary?.userLibrary?.entries?.filter((entry:{categoryIds:string[]})=>entry.categoryIds.includes('effect:music:0')).length)).toBe(2);
    await pool.getByRole('button',{name:'试听序列 1 灯光步 1.000',exact:true}).click({button:'right'});
    await menu.getByRole('button',{name:'移除素材',exact:true}).click();
    await expect(pool).toHaveAttribute('data-total-cues','4499');
    await page.keyboard.press('Control+z');await expect(pool).toHaveAttribute('data-total-cues','4500');await page.keyboard.press('Control+y');await expect(pool).toHaveAttribute('data-total-cues','4499');
    await expect.poll(() => savedValue(page, async () => parseLinkProject(JSON.parse(await readFile(file,'utf8'))).ma2MaterialLibrary?.userLibrary?.hiddenConsoleCues?.length)).toBe(1);
    const saved=parseLinkProject(JSON.parse(await readFile(file,'utf8')));expect(saved.ma2MaterialLibrary?.library?.sequences).toHaveLength(1000);
    // Reopen the actual saved project through the normal project loader.
    await page.getByRole('navigation',{name:'主要工作区'}).getByRole('button',{name:'节目单',exact:true}).click();
    await page.getByLabel('工程菜单',{exact:true}).click();
    await page.getByRole('button',{name:'打开工程',exact:true}).click();
    await page.getByRole('navigation',{name:'主要工作区'}).getByRole('button',{name:'灯光工作台',exact:true}).click();
    await navigation.getByRole('button',{name:/控台/}).click();
    await expect(pool).toHaveAttribute('data-total-cues','4499');
    await preview.getByRole('textbox',{name:'搜索序列或 Cue'}).fill('分类暖白');
    await expect(pool).toHaveAttribute('data-total-cues','1');
    await expect(pool.getByRole('button').first().locator('strong')).toHaveText('分类暖白');
    await preview.getByRole('textbox',{name:'搜索序列或 Cue'}).fill('');
    await preview.getByRole('button', { name: '素材筛选', exact: true }).click();
    await page.getByRole('dialog', { name: '素材筛选', exact: true }).getByRole('button',{name:'已移除',exact:true}).click();await expect(pool).toHaveAttribute('data-total-cues','1');
    await preview.getByRole('button', { name: '素材筛选', exact: true }).click();
    await pool.getByRole('button').first().click({button:'right'});await menu.getByRole('button',{name:'恢复素材',exact:true}).click();
    await expect(pool).toHaveAttribute('data-total-cues','4500');
    await preview.getByRole('button',{name:'单步',exact:true}).click();
    await page.screenshot({path:info.outputPath('manual-classification.png')});

    // A disconnected target is a reviewable failure, never an automatic Off on the new console.
    const callsBeforeReview=await application.evaluate(()=>process.env.TBLINK_LIBRARY_CALLS);
    await application.evaluate(({ipcMain,BrowserWindow})=>{
      let state:Ma2AuditionState={version:1,revision:10000,generation:100,phase:'failed',targets:[{id:'previous-console-8999',network:{host:'192.0.2.1',port:30000,monitorPort:30001,username:'test'},action:{target:'sequence',sequence:8999,action:'off'},state:'failed',error:'控台连接已改变，原试听目标尚未确认关闭',connectionChanged:true}]};
      ipcMain.removeHandler('link:ma2-audition-control');
      ipcMain.handle('link:ma2-audition-control',(_event,input:{action:string;targetId?:string})=>{
        if(input.action==='acknowledge-closed'){
          process.env.TBLINK_REVIEWED_TARGET=input.targetId;
          // First request models cancelling the native confirmation, second confirms.
          if(process.env.TBLINK_REVIEW_CONFIRM==='1')state={...state,revision:state.revision+1,phase:'idle',targets:[]};
        }
        _event.sender.send('link:ma2-audition-state',state);return state;
      });
      BrowserWindow.getAllWindows()[0]?.webContents.send('link:ma2-audition-state',state);
    });
    await preview.getByText('原连接待核对 · 1 项',{exact:true}).click();
    await expect(preview.getByRole('alert')).toContainText('序列 8999');
    await preview.getByRole('button',{name:'核对原控台',exact:true}).click();
    await expect(preview.getByText('原连接待核对 · 1 项',{exact:true})).toBeVisible();
    await expect.poll(()=>application.evaluate(()=>process.env.TBLINK_REVIEWED_TARGET)).toBe('previous-console-8999');
    await page.screenshot({path:info.outputPath('previous-connection-review.png')});
    await application.evaluate(()=>{process.env.TBLINK_REVIEW_CONFIRM='1';});
    await preview.getByRole('button',{name:'核对原控台',exact:true}).click();
    await expect(preview.getByText('原连接待核对 · 1 项',{exact:true})).toHaveCount(0);
    expect(await application.evaluate(()=>process.env.TBLINK_LIBRARY_CALLS)).toBe(callsBeforeReview);

  } finally {
    if (!page.isClosed()) { await page.screenshot({ path: info.outputPath('final.png') }); await writeFile(info.outputPath('page.txt'), await page.locator('body').innerText()); }
    if (!page.isClosed()) await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }));
    if (application.process().exitCode === null) await application.close();
  }
});

