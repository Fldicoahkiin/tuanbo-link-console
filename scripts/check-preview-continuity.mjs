import { chromium, expect } from '../apps/desktop/node_modules/@playwright/test/index.mjs';
const browser=await chromium.launch({headless:true,channel:'msedge'});
const page=await browser.newPage();
try {
 await page.route('**/__preview-check',r=>r.fulfill({contentType:'text/html',body:'<div id="test"></div>'}));
 await page.goto('http://localhost:5173/__preview-check');
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.injectIntoGlobalHook(globalThis);globalThis.$RefreshReg$=()=>{};globalThis.$RefreshSig$=()=>type=>type;
  const src=await(await fetch('/src/main.tsx')).text();
  const {default:React}=await import(src.match(/from "([^"]*deps\/react\.js[^"]*)"/)[1]);
  const {default:{createRoot}}=await import(src.match(/from "([^"]*deps\/react-dom_client.js[^"]*)"/)[1]);
  const canvas=globalThis.document.createElement('canvas');canvas.width=64;canvas.height=64;canvas.getContext('2d').fillRect(0,0,64,64);
  const stream=canvas.captureStream(30),recorder=new globalThis.MediaRecorder(stream,{mimeType:'video/webm'}),parts=[];
  recorder.ondataavailable=e=>parts.push(e.data);const stopped=new Promise(resolve=>{recorder.onstop=resolve;});recorder.start();const draw=setInterval(()=>{canvas.getContext('2d').fillStyle=`rgb(${Math.floor(Math.random()*255)},0,0)`;canvas.getContext('2d').fillRect(0,0,64,64);},30);await new Promise(resolve=>setTimeout(resolve,1200));clearInterval(draw);recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());
  const url=URL.createObjectURL(new Blob(parts,{type:'video/webm'}));globalThis.requests=0;
  globalThis.tbLink={ensureMediaPreviewUrl:async()=>{globalThis.requests++;return url;},getObsSourceScreenshot:async()=>canvas.toDataURL()};
  const {ReferenceStage}=await import('/src/link/components/ReferenceStage.tsx');
  const root=createRoot(globalThis.document.getElementById('test'));
  const layer={id:'layer',visible:true,locked:false};
  const asset={id:'asset',name:'sample',kind:'video',relativePath:'sample.webm',sha256:'a'.repeat(64)};
  const clip={id:'clip',assetId:'asset',sourceOffsetMs:0,canvasTransform:{x:.5,y:.5,scale:1,scaleX:1,scaleY:1,rotation:0}};
  const noop=()=>{};
  globalThis.renderPreview=(at,covered)=>root.render(React.createElement(ReferenceStage,{sceneMode:true,activeMediaClipId:covered?null:'clip',scenePreview:covered?{cueId:'cue',sceneName:'Camera'}:null,projectPath:'test.tblink',itemTitle:'test',playheadMs:at,playing:false,obsStatus:'connected',obsInventory:null,outputCanvas:{width:64,height:64},obsSceneCount:1,obsInputCount:1,selectedClipId:null,selectedCueId:null,selectedAsset:null,onSelectClip:noop,onSelectCue:noop,onSelectObsResource:noop,onTransformClip:noop,onMoveClipToTop:noop,onRemoveClip:noop,onTransformObs:noop,onMoveObsToTop:noop,onRemoveObs:noop,onDropObsResource:noop,timelineState:{clips:[{clip,asset,layer,startMs:100,endMs:1500,visual:at>=100,active:at>=100}],layers:[{layer,activeObsCues:[]}],activeClipIds:at>=100?['clip']:[],activeAudioClipIds:[],activeObsCueIds:[]}}));
  globalThis.renderPreview(0,false);
 });
 const video=page.locator('video');await expect(video).toHaveCount(1);
 await expect.poll(()=>video.evaluate(v=>v.readyState)).toBeGreaterThanOrEqual(2);
 await video.evaluate(v=>{globalThis.originalVideo=v;});
 await expect(video).toBeHidden();
 await page.evaluate(()=>globalThis.renderPreview(300,false));await expect(video).toBeVisible();
 await page.evaluate(()=>globalThis.renderPreview(600,true));await expect(video).toBeHidden();
 await page.evaluate(()=>globalThis.renderPreview(900,false));await expect(video).toBeVisible();
 expect(await video.evaluate(v=>v===globalThis.originalVideo)).toBe(true);
 expect(await page.evaluate(()=>globalThis.requests)).toBe(1);
 await expect.poll(()=>video.evaluate(v=>Math.abs(v.currentTime-.8))).toBeLessThan(.05);
 console.log('通过：提前准备、机位遮挡、返回视频复用同一节点和 URL，恢复到正确位置。');
} finally {await browser.close();}
