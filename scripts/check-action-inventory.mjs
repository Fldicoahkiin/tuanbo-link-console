import { chromium, expect } from '../apps/desktop/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage();
await page.route('**/__action-regression', route => route.fulfill({contentType:'text/html',body:'<div id="test"></div>'}));
await page.goto('http://localhost:5173/__action-regression');
const errors=[];
page.on('pageerror', error=>errors.push(error.message));
page.on('console', message=>{if(message.type()==='error' && /getSnapshot|Maximum update|above error occurred/.test(message.text()))errors.push(message.text());});
try {
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');
  refresh.injectIntoGlobalHook(globalThis);
  globalThis.$RefreshReg$=()=>{};
  globalThis.$RefreshSig$=()=>type=>type;
  const source=await (await fetch('/src/main.tsx')).text();
  const reactPath=source.match(/from "([^"]*deps\/react\.js[^"]*)"/)[1];
  const domPath=source.match(/from "([^"]*deps\/react-dom_client.js[^"]*)"/)[1];
  const {default: React}=await import(reactPath);
  const {default: {createRoot}}=await import(domPath);
  const {ActionEditor}=await import('/src/link/components/ActionEditor.tsx');
  globalThis.testRoot=createRoot(globalThis.document.getElementById('test'));
  globalThis.testRoot.render(React.createElement(ActionEditor,{itemId:'test',cueId:'test',index:0,actionCount:1,onTest:async()=>{},action:{id:'test',kind:'obs.setProgramScene',label:'测试场景',sceneName:'Program',transition:{name:'Saved Fade',durationMs:300}}}));
 });
 await page.waitForTimeout(500);
 await expect(page.getByRole('combobox', { name: 'Cue OBS 转场' })).toHaveValue('Saved Fade');
 for (const available of [true, false, true, false]) {
  await page.evaluate(async (loaded) => {
   const {useIntegrationStore}=await import('/src/link/stores/integration-store.ts');
   useIntegrationStore.getState().setInventory(loaded ? {scenes:['Program','Second'],transitions:['Cut'],inputs:[],inputKinds:{},inputAudioStates:{},sceneItems:{},filters:{},sourceSizes:{}} : null);
  }, available);
  await page.waitForTimeout(100);
  await expect(page.locator('option', {hasText:'Second'})).toHaveCount(available ? 1 : 0);
  await expect(page.getByRole('combobox', { name: 'Cue OBS 转场' })).toHaveValue('Saved Fade');
 }
 expect(errors).toEqual([]);
 console.log('通过：OBS 信息缺失、加载及反复清空均无重绘循环，保留已选场景与转场。');
} finally {await page.close();await browser.close();}
