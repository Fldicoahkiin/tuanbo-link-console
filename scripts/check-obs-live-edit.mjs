import { chromium, expect } from '../apps/desktop/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({headless:true,channel:'msedge'});
const page = await browser.newPage({viewport:{width:1180,height:800}});
const {OBSWebSocket}=await import('../apps/desktop/node_modules/obs-websocket-js/dist/json.js');
const ws=new OBSWebSocket();await ws.connect('ws://127.0.0.1:4457');
const errors=[];
page.on('pageerror', error=>errors.push(error.message));
try {
 await page.exposeFunction('readLiveScene',async()=>{const current=await ws.call('GetCurrentProgramScene');const items=await ws.call('GetSceneItemList',{sceneName:current.sceneName});const video=await ws.call('GetVideoSettings');return {sceneName:current.sceneName,items:items.sceneItems,width:video.baseWidth,height:video.baseHeight};});
 await page.exposeFunction('editLiveScene',async(edit)=>{await ws.call('SetSceneItemTransform',{sceneName:edit.sceneName,sceneItemId:edit.sceneItemId,sceneItemTransform:edit.transform});});
 await page.route('**/__timeline-menu', route=>route.fulfill({contentType:'text/html',body:'<div id="test"></div>'}));
 await page.goto('http://localhost:5173/__timeline-menu');
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.injectIntoGlobalHook(globalThis);globalThis.$RefreshReg$=()=>{};globalThis.$RefreshSig$=()=>type=>type;
  const source=await(await fetch('/src/main.tsx')).text();
  const {default:React}=await import(source.match(/from "([^"]*deps\/react\.js[^"]*)"/)[1]);
  const {default:{createRoot}}=await import(source.match(/from "([^"]*deps\/react-dom_client.js[^"]*)"/)[1]);
  await import('/src/link/link.css');await import('/src/link/appearance.css');await import('/src/link/timeline-editing.css');
  const {ObsLiveSelection}=await import('/src/link/components/ObsLiveSelection.tsx');
  const {obsLiveSceneSchema}=await import('/@fs/C:/Users/WYZB/Documents/ChatGPT/团播切片/packages/schema/src/obs-live-canvas.ts');
  const root=createRoot(globalThis.document.getElementById('test'));
  globalThis.renderScene=async()=>{const scene=obsLiveSceneSchema.parse(await globalThis.readLiveScene());globalThis.scene=scene;root.render(React.createElement('div',{className:'obs-live-canvas',style:{position:'relative',width:640,height:360}},React.createElement(ObsLiveSelection,{scene,selected:scene.items[0].sceneItemId,onSelect:()=>{},onEdit:(edit,dragging)=>{if(!dragging)globalThis.commit=globalThis.editLiveScene(edit);}})));};
  await globalThis.renderScene();
 });
 const source=page.locator('.obs-live-source').first();await expect(source).toBeVisible();const before=await source.boundingBox();
 await page.mouse.move(before.x+30,before.y+30);await page.mouse.down();await page.mouse.move(before.x+80,before.y+50,{steps:6});await page.mouse.up();await page.evaluate(()=>globalThis.commit);
 const initial=await page.evaluate(()=>globalThis.scene);const id=initial.items[0].sceneItemId;const original=initial.items[0].sceneItemTransform;
 const after=await ws.call('GetSceneItemTransform',{sceneName:initial.sceneName,sceneItemId:id});
 expect(after.sceneItemTransform.positionX-original.positionX).toBeCloseTo(50*initial.width/640,0);
 expect(after.sceneItemTransform.positionY-original.positionY).toBeCloseTo(20*initial.height/360,0);
 await ws.call('SetSceneItemTransform',{sceneName:initial.sceneName,sceneItemId:id,sceneItemTransform:{positionX:160,positionY:80}});await page.evaluate(()=>globalThis.renderScene());
 await expect.poll(async()=>Math.round((await source.boundingBox()).x)).toBe(Math.round(160/initial.width*640));
 await ws.call('SetSceneItemTransform',{sceneName:initial.sceneName,sceneItemId:id,sceneItemTransform:{positionX:original.positionX,positionY:original.positionY,scaleX:original.scaleX,scaleY:original.scaleY}});
 expect(errors).toEqual([]);console.log('通过：鼠标拖动画布写回真实 OBS，OBS 修改位置后边框同步。');
} finally {await ws.disconnect();await browser.close();}
