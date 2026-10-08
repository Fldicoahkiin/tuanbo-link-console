import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const directory = resolve(process.argv[2] ?? 'artifacts/editor-recovery'); await mkdir(directory, { recursive: true });
const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const { chromium, expect } = requireDesktop('@playwright/test');
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ObsLiveCanvas} from './src/renderer/src/link/components/ObsLiveCanvas'; import {useTimelinePlaybackClock} from './src/renderer/src/link/components/useTimelinePlaybackClock';
function Harness(){const [position,setPosition]=React.useState(0); const [tick,setTick]=React.useState(0); React.useEffect(()=>{const timer=setInterval(()=>setTick(x=>x+1),5);return()=>clearInterval(timer)},[]);useTimelinePlaybackClock({playing:true,playheadMs:position,durationMs:100000,frameRate:'30',itemId:'test',onPlayheadChange:ms=>setPosition(ms),onPlayingChange:()=>{}});return React.createElement(React.Fragment,null,React.createElement('output',{id:'clock','data-tick':tick},String(position)),React.createElement(ObsLiveCanvas));}createRoot(document.getElementById('root')).render(React.createElement(Harness));`, resolveDir: resolve('apps/desktop'), loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.setContent('<style>#root{height:600px}.obs-live-canvas{position:relative}.obs-live-canvas canvas{width:100%;height:100%}.obs-live-selection{position:absolute;inset:0}.obs-live-source{position:absolute;border:2px solid yellow}</style><div id="root"></div>');
  await page.addStyleTag({ content: await readFile('apps/desktop/src/renderer/src/link/timeline-editing.css', 'utf8') });
  await page.evaluate(() => {
    const transform = { positionX: 40, positionY: 40, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, alignment: 5, sourceWidth: 300, sourceHeight: 200, width: 300, height: 200, boundsType: 'OBS_BOUNDS_NONE', boundsWidth: 0, boundsHeight: 0 };
    const state = { name: 'A', reads: 0, edits: [], changeOnEdit: true, listener: () => {}, transform };
    globalThis.window.fixture = state;
    globalThis.window.tbLink = {
      onWindowVisibilityChanged: () => () => {}, getWindowVisible: async () => true,
      onObsLiveChanged: listener => { state.listener = listener; return () => { state.listener = () => {}; }; },
      readObsLiveScene: async () => { state.reads++; const scene = { sceneName: state.name, width: 640, height: 360, items: [{ sceneItemId: 1, sourceName: state.name, sceneItemEnabled: true, sceneItemLocked: false, sceneItemIndex: 0, sceneItemTransform: { ...state.transform } }] }; if(state.holdRead){state.holdRead=false; await new Promise(resolve=>{state.releaseRead=resolve;});} return scene; },
      editObsLiveScene: async edit => { state.edits.push(edit); if(state.changeOnEdit){state.changeOnEdit=false;state.name='B';state.listener();throw new Error('OBS 场景已切换，本次编辑已停止');} if(edit.sceneName!==state.name)throw new Error('stale target'); Object.assign(state.transform,edit.transform);state.listener();await new Promise(r=>setTimeout(r,20)); },
      getObsLiveFrame: async () => { await new Promise(r=>setTimeout(r,33)); return {width:2,height:2,sequence:1,timestampNs:'0',rgba:new Uint8Array(16)}; },
      closeObsLivePreview: async () => {}, recordLog: async () => ({})
    };
  });
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
  const source = page.locator('.obs-live-source'); await expect(source).toHaveAttribute('title','A');
  let bounds = await source.boundingBox();
  await page.mouse.move(bounds.x + 50,bounds.y + 50);await page.mouse.down();await page.mouse.move(bounds.x + 80,bounds.y + 60);await page.mouse.up();
  await expect(source).toHaveAttribute('title','B'); await expect(page.locator('.stage-error')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'检查并修复组件'})).toHaveCount(0);
  const before = await page.evaluate(()=>({reads:globalThis.window.fixture.reads,edits:globalThis.window.fixture.edits.length,x:globalThis.window.fixture.transform.positionX}));
  bounds=await source.boundingBox();await page.mouse.move(bounds.x+50,bounds.y+50);await page.mouse.down();
  for(let i=1;i<=15;i++){await page.mouse.move(bounds.x+50+i*2,bounds.y+50+i);await page.waitForTimeout(10);}
  const during = await page.evaluate(()=>globalThis.window.fixture.reads); assert.equal(during,before.reads,'Dragging must not repeatedly read the whole scene');
  await page.mouse.up();await expect.poll(()=>page.evaluate(()=>globalThis.window.fixture.reads)).toBeGreaterThan(before.reads);
  const after=await page.evaluate(()=>({edits:globalThis.window.fixture.edits,x:globalThis.window.fixture.transform.positionX}));assert(after.x>before.x);assert(after.edits.slice(before.edits).every(edit=>edit.sceneName==='B'));
  await page.evaluate(()=>{globalThis.window.fixture.holdRead=true;globalThis.window.fixture.listener();});
  bounds=await source.boundingBox();await page.mouse.move(bounds.x+40,bounds.y+40);await page.mouse.down();await page.mouse.move(bounds.x+90,bounds.y+55);await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>globalThis.window.fixture.transform.positionX)).toBeGreaterThan(after.x);
  await page.waitForTimeout(100);
  const currentLeft=await source.evaluate(element=>element.style.left);
  await page.evaluate(()=>globalThis.window.fixture.releaseRead());await page.waitForTimeout(100);
  assert.equal(await source.evaluate(element=>element.style.left),currentLeft,'A delayed scene read must not undo the latest drag');
  const clockBefore=Number(await page.locator('#clock').textContent());await page.waitForTimeout(1200);const elapsed=Number(await page.locator('#clock').textContent())-clockBefore;assert(elapsed>=1100 && elapsed<=1350,`Re-renders reset timeline clock: ${elapsed}`);
  assert.deepEqual(errors,[]);await page.screenshot({path:join(directory,'recovered.png')});
  await writeFile(join(directory,'acceptance.json'),JSON.stringify({syntheticObs:true,sceneChangeRecovery:true,oldSceneWriteNotRetried:true,delayedReadDoesNotUndoDrag:true,sceneReadsDuringDrag:during-before.reads,clockAdvancedMs:elapsed,errors},null,2));
} finally {await browser.close();}
console.log('组件回归通过：场景切换后恢复拖动，旧动作不重发，拖动期间无重复整场景读取，频繁重渲染不重置游标时钟。非实体 OBS 验收。');
