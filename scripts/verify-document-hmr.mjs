import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { chromium, expect } = requireDesktop('@playwright/test');
const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: true });
const bundle = await build({ stdin: { contents: `export {useDocumentStore} from './src/renderer/src/link/stores/document-store'; export {createEmptyLinkProject} from '@tb/schema'; export {renameProjectCommand} from '@tb/core/link'; globalThis.window.hmrLoads=(globalThis.window.hmrLoads??0)+1;`, resolveDir: resolve('apps/desktop'), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
const code = bundle.outputFiles[0].text;
await writeFile(join(directory, 'store.js'), code);
await writeFile(join(directory, 'index.html'), `<output id="name"></output><script type="module">
import {useDocumentStore,createEmptyLinkProject,renameProjectCommand} from './store.js';
const store=useDocumentStore; globalThis.fixture={store,rename: name=>store.getState().execute(renameProjectCommand(name))};
store.getState().setProject(createEmptyLinkProject('打开的工程'),'C:/test/opened.tblink');
globalThis.fixture.rename('未保存修改');
store.subscribe(state=>document.querySelector('#name').textContent=state.project?.name??'尚未打开工程');
document.querySelector('#name').textContent=store.getState().project.name;
globalThis.fixture.initial=store.getState();
</script>`);
const server = await createServer({ configFile: false, root: directory, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === 'string') throw new Error('测试服务器端口不可用');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${address.port}`);
  await expect(page.locator('#name')).toHaveText('未保存修改');
  for (let revision = 1; revision <= 3; revision++) {
    // Only the isolated generated module is changed, never the user's dev source.
    await writeFile(join(directory, 'store.js'), `${code}\n// HMR verification ${revision}\n`);
    await expect.poll(() => page.evaluate(() => globalThis.window.hmrLoads)).toBe(revision + 1);
    const state = await page.evaluate(() => {
      const { store, initial } = globalThis.window.fixture;
      const current = store.getState();
      return { projectSame: current.project === initial.project, path: current.path, documentId: current.documentId,
        sameSession: current.documentId === initial.documentId, dirty: current.dirty, historySame: current.past === initial.past,
        actionsUpdated: current.execute !== initial.execute };
    });
    assert(state.projectSame && state.sameSession && state.dirty && state.historySame && state.actionsUpdated);
    assert.equal(state.path, 'C:/test/opened.tblink');
    await expect(page.locator('#name')).toHaveText('未保存修改');
  }
  await page.evaluate(() => globalThis.window.fixture.store.getState().undo());
  await expect(page.locator('#name')).toHaveText('打开的工程');
  await page.evaluate(() => globalThis.window.fixture.store.getState().redo());
  await expect(page.locator('#name')).toHaveText('未保存修改');
  await page.evaluate(() => globalThis.window.fixture.rename('热更新后继续编辑'));
  await expect(page.locator('#name')).toHaveText('热更新后继续编辑');
  assert.deepEqual(errors, []);
  await writeFile(join(directory, 'acceptance.json'), JSON.stringify({ realViteHmr: true, replacements: 3,
    projectAndUnsavedHistoryRetained: true, oldSubscriberStillReceivesEdits: true, undoRedoAfterUpdate: true, errors }, null, 2));
} finally { await browser.close(); await server.close(); }
assert((await readFile('apps/desktop/electron.vite.config.ts', 'utf8')).includes('plugins: [react()]'));
console.log('真实 Vite 热更新三次：工程、路径、会话、未保存历史和旧订阅保留，继续编辑及撤销重做通过。');
