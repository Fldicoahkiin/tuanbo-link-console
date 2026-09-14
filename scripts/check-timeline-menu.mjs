import { chromium, expect } from '../apps/desktop/node_modules/@playwright/test/index.mjs';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({headless:true,channel:'msedge'});
const page = await browser.newPage({viewport:{width:1180,height:800}});
const errors=[];
page.on('pageerror', error=>errors.push(error.message));
try {
 await page.route('**/__timeline-menu', route=>route.fulfill({contentType:'text/html',body:'<div id="test"></div>'}));
 await page.goto('http://localhost:5173/__timeline-menu');
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.injectIntoGlobalHook(globalThis);globalThis.$RefreshReg$=()=>{};globalThis.$RefreshSig$=()=>type=>type;
  const source=await(await fetch('/src/main.tsx')).text();
  const {default:React}=await import(source.match(/from "([^"]*deps\/react\.js[^"]*)"/)[1]);
  const {default:{createRoot}}=await import(source.match(/from "([^"]*deps\/react-dom_client.js[^"]*)"/)[1]);
  await import('/src/link/link.css');await import('/src/link/appearance.css');await import('/src/link/timeline-editing.css');
  const {TimelineContextMenu}=await import('/src/link/components/TimelineContextMenu.tsx');
  const {TimelineClip,CueLane}=await import('/src/link/components/TimelineItems.tsx');
  const root=createRoot(globalThis.document.getElementById('test'));
  const clip={id:'clip',assetId:'video',label:'演出素材.mp4',startTimecode:{hours:0,minutes:0,seconds:1,frames:0},durationMs:6000,sourceOffsetMs:0,layerId:'layer'};
  const cue={id:'cue',name:'机位 1',timecode:clip.startTimecode,durationMs:6000,layerId:'layer',actions:[{id:'a',kind:'obs.setProgramScene',label:'场景',sceneName:'Camera'}]};
  globalThis.calls=[];
  const record=(name)=>(...args)=>globalThis.calls.push({name,args});
  globalThis.renderMenu=(kind='clip',locked=false,clipboard={kind:'clip',id:'clip'},theme='dark',pointCue=false)=>{
   globalThis.document.documentElement.dataset.theme=theme;
   root.render(React.createElement(React.Fragment,null,
    React.createElement('section',{className:'reference-timeline',style:{position:'absolute',left:50,top:80,width:650,height:50}},React.createElement(TimelineClip,{clip,asset:{kind:'video'},resolvedStartMs:1000,resolvedDurationMs:6000,frameRate:'30',pixelsPerSecond:80,selected:true,active:false,locked,previewMs:null,previewDurationMs:null,previewOffsetY:null,onSelect:record('select'),onPointerDown:record('drag'),onContextMenu:record('context'),onTrimPointerDown:record('trimDrag')})),
    React.createElement('section',{className:'reference-timeline',style:{position:'absolute',left:50,top:150,width:650,height:50,display:'grid',gridTemplateRows:'50px'}},React.createElement(CueLane,{cues:[{...cue,durationMs:undefined}],frameRate:'30',selectedCueId:'cue',device:'all',pixelsPerSecond:80,drag:null,lanePointer:{},onBeginDrag:record('drag'),onSelectCue:record('select')})),
    React.createElement(TimelineContextMenu,{context:{target:kind?{kind,id:kind}:null,x:1165,y:790},clipboard,clips:[clip],cues:[pointCue ? {...cue,durationMs:undefined} : cue],layers:[{id:'layer',locked}],frameRate:'30',playheadMs:3000,actions:Object.fromEntries(['onDeleteClip','onDeleteCue','onDuplicateClip','onDuplicateCue','onSplitClip','onTrimClip','onTrimCue','onSetClipEmbeddedAudioEnabled'].map(name=>[name,record(name)])),onCopy:record('copy'),onSeek:record('seek'),onClose:record('close')})));
  };
  globalThis.renderMenu();
 });
 const menu=page.getByRole('menu',{name:'时间线右键菜单'});
 await expect(menu).toBeVisible();
 const bounds=await menu.boundingBox();expect(bounds.x+bounds.width).toBeLessThanOrEqual(1180);expect(bounds.y+bounds.height).toBeLessThanOrEqual(800);
 await expect(page.locator('.timeline-clip')).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.timeline-cue > small')).toHaveCount(0);
 await expect(page.locator('.timeline-cue > span')).toHaveText('Camera');
 const cueText=await page.locator('.timeline-cue > span').boundingBox();
 const cueBox=await page.locator('.timeline-cue').boundingBox();
 expect(cueText.y).toBeGreaterThanOrEqual(cueBox.y);
 expect(cueText.y+cueText.height).toBeLessThanOrEqual(cueBox.y+cueBox.height);
 await mkdir('acceptance-20260914-timeline-menu',{recursive:true});
 for(const theme of ['dark','light']) {await page.evaluate(t=>globalThis.renderMenu('clip',false,undefined,t),theme);await page.screenshot({path:`acceptance-20260914-timeline-menu/${theme}.png`});}
 for(const [kind,label,call] of [['clip','删除','onDeleteClip'],['cue','删除','onDeleteCue'],['clip','在播放头分割','onSplitClip'],['cue','在后方创建副本','onDuplicateCue'],['clip','将开头修剪至播放头','onTrimClip'],['cue','将结尾修剪至播放头','onTrimCue'],['clip','关闭素材原声','onSetClipEmbeddedAudioEnabled']]) {
  await page.evaluate(k=>globalThis.renderMenu(k),kind);
  await menu.getByRole('menuitem',{name:new RegExp('^'+label)}).click();
  expect(await page.evaluate(()=>globalThis.calls.at(-1).name)).toBe(call);
 }
 await page.evaluate(()=>globalThis.renderMenu('clip',true));
 await expect(menu.getByRole('menuitem',{name:/^删除/})).toBeDisabled();
 await expect(menu.getByRole('menuitem',{name:/^在播放头分割/})).toBeDisabled();
 await page.evaluate(()=>globalThis.renderMenu(null,false));
 await menu.getByRole('menuitem',{name:'粘贴到播放头',exact:false}).click();
 expect(await page.evaluate(()=>globalThis.calls.at(-1))).toEqual({name:'onDuplicateClip',args:['clip',3000]});
 await page.evaluate(()=>globalThis.renderMenu('cue',false));
 await expect(menu.locator('.timeline-menu-title')).toHaveText('Camera');
 await expect(menu.getByRole('menuitem',{name:/^复制/}).first()).toBeFocused();
 await page.keyboard.press('End');await expect(menu.getByRole('menuitem',{name:/^删除/})).toBeFocused();
 await page.keyboard.press('Escape');expect(await page.evaluate(()=>globalThis.calls.at(-1).name)).toBe('close');
 for (const theme of ['dark','light']) {
  await page.evaluate(t=>globalThis.renderMenu('cue',false,{kind:'cue',id:'cue'},t,true),theme);
  await expect(menu.getByRole('menuitem',{name:'定位到触发点'})).toBeVisible();
  await expect(menu.getByRole('menuitem',{name:/修剪|定位到结尾|分割/})).toHaveCount(0);
  await menu.getByRole('menuitem',{name:'定位到触发点'}).click();
  expect(await page.evaluate(()=>globalThis.calls.at(-1))).toEqual({name:'seek',args:[1000]});
  await menu.getByRole('menuitem',{name:/在原位置创建副本/}).click();
  expect(await page.evaluate(()=>globalThis.calls.at(-1))).toEqual({name:'onDuplicateCue',args:['cue',1000]});
  await menu.getByRole('menuitem',{name:/^删除/}).click();
  expect(await page.evaluate(()=>globalThis.calls.at(-1))).toEqual({name:'onDeleteCue',args:['cue']});
 }
 expect(errors).toEqual([]);console.log('通过：素材/Cue 右键操作、锁定限制、空白粘贴、键盘导航、菜单边界与深浅主题。');
} finally {await browser.close();}
