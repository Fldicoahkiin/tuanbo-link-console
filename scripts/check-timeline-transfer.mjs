import { chromium, expect } from '../apps/desktop/node_modules/@playwright/test/index.mjs';
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
  const {useTimelineItemDrag}=await import('/src/link/components/useTimelineItemDrag.ts');
  globalThis.moves=[];
  function Harness(){
   const drag=useTimelineItemDrag({clips:[{id:'video',layerId:'one'}],cues:[{id:'scene',layerId:'one'}],layers:[{id:'one'},{id:'two'}],focusTimeline:()=>{},timeAtClientX:x=>x*10,snapTime:x=>x,onSelectClip:()=>{},onSelectCue:()=>{},onMoveClip:(...a)=>globalThis.moves.push(['clip',...a]),onMoveCue:(...a)=>globalThis.moves.push(['cue',...a]),onMoveLayer:()=>{throw Error('不应移动整条轨道');}});
   return React.createElement('div',null,...['one','two'].map(id=>React.createElement('div',{'data-visual-layer-id':id,key:id,style:{height:100,width:500,background:'#333',margin:10}},id==='one'?['clip','cue'].map((kind,i)=>React.createElement('button',{key:kind,style:{width:100,height:40},onPointerDown:e=>drag.begin(e,kind,i?'scene':'video',0),onPointerMove:drag.move,onPointerUp:drag.end,onPointerCancel:drag.cancel},kind)):null)));
  }
  createRoot(globalThis.document.getElementById('test')).render(React.createElement(Harness));
 });
 for(const kind of ['clip','cue']){
  const source=await page.getByRole('button',{name:kind,exact:true}).boundingBox();const target=await page.locator('[data-visual-layer-id="two"]').boundingBox();
  await page.mouse.move(source.x+30,source.y+20);await page.mouse.down();await page.mouse.move(target.x+200,target.y+40,{steps:8});await page.mouse.up();
 }
 expect((await page.evaluate(()=>globalThis.moves)).map(m=>[m[0],m[3]])).toEqual([['clip','two'],['cue','two']]);
 expect(errors).toEqual([]);console.log('通过：视频和场景均可拖入同一目标时间线，不触发整轨重排。');
} finally {await browser.close();}
