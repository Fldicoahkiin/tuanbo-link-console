import { chromium, expect } from '../apps/desktop/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({headless:true,channel:'msedge'});
const page = await browser.newPage({viewport:{width:1180,height:800}});
try {
 await page.route('**/__resize-check',route=>route.fulfill({contentType:'text/html',body:'<div id="test"></div>'}));
 await page.goto('http://localhost:5173/__resize-check');
 await page.evaluate(async()=>{
  const refresh=await import('/@react-refresh');refresh.injectIntoGlobalHook(globalThis);globalThis.$RefreshReg$=()=>{};globalThis.$RefreshSig$=()=>type=>type;
  const source=await(await fetch('/src/main.tsx')).text();
  const {default:React}=await import(source.match(/from "([^"]*deps\/react\.js[^"]*)"/)[1]);
  const {default:{createRoot}}=await import(source.match(/from "([^"]*deps\/react-dom_client.js[^"]*)"/)[1]);
  await import('/src/link/link.css');await import('/src/link/appearance.css');await import('/src/link/timeline-editing.css');
  const {TimelineClip,CueLane}=await import('/src/link/components/TimelineItems.tsx');
  const {useClipResize,useCueResize}=await import('/src/link/components/useTimelineResize.ts');
  function Harness(){
   const [clip,setClip]=React.useState({id:'clip',assetId:'video',label:'视频',startTimecode:{hours:0,minutes:0,seconds:1,frames:0},durationMs:6000,sourceOffsetMs:1000});
   const [selected,select]=React.useState(false);
   const resize=useClipResize({durationMs:12000,frameRate:'30',timeAtClientX:x=>(x-50)*10,focusTimeline:()=>{},snapEnabled:false,getSnapPointsMs:()=>[],snapThresholdMs:0,onSelectClip:()=>select(true),onTrimClip:(id,start,duration)=>{globalThis.result={id,start,duration};setClip(c=>({...c,durationMs:duration}));}});
   return React.createElement('section',{className:'reference-timeline',style:{position:'absolute',left:50,top:100,width:1100,height:50}},React.createElement(TimelineClip,{clip,asset:{kind:'video',durationMs:12000},resolvedStartMs:1000,resolvedDurationMs:clip.durationMs,frameRate:'30',pixelsPerSecond:100,selected,active:false,locked:false,previewMs:resize.drag?.previewStartMs??null,previewDurationMs:resize.drag?.previewDurationMs??null,previewOffsetY:null,onSelect:()=>select(true),onPointerDown:()=>{},onTrimPointerDown:resize.begin,onTrimPointerMove:resize.move,onTrimPointerUp:resize.end,onTrimPointerCancel:resize.cancel}));
  }
  function SceneHarness(){
   const [cue,setCue]=React.useState({id:'cue',name:'场景',timecode:{hours:0,minutes:0,seconds:1,frames:0},actions:[{id:'a',kind:'obs.setProgramScene',sceneName:'Camera'}]});
   const resize=useCueResize({durationMs:12000,frameRate:'30',timeAtClientX:x=>(x-50)*10,focusTimeline:()=>{},snapEnabled:false,getSnapPointsMs:()=>[],snapThresholdMs:0,onSelectCue:()=>{},onTrimCue:(id,start,duration)=>{globalThis.cueResult={id,start,duration};setCue(c=>({...c,durationMs:duration,timecode:{hours:0,minutes:0,seconds:Math.floor(start/1000),frames:Math.round(start%1000/1000*30)}}));}});
   return React.createElement('section',{className:'reference-timeline',style:{position:'absolute',left:50,top:250,width:1100,height:50,display:'grid',gridTemplateRows:'50px'}},React.createElement(CueLane,{cues:[cue],frameRate:'30',selectedCueId:'cue',device:'all',visualClipMode:true,pixelsPerSecond:100,drag:null,resizeDrag:resize.drag,lanePointer:{},onBeginDrag:()=>{},onTrimPointerDown:resize.begin,onTrimPointerMove:resize.move,onTrimPointerUp:resize.end,onTrimPointerCancel:resize.cancel}));
  }
  createRoot(globalThis.document.getElementById('test')).render(React.createElement(React.Fragment,null,React.createElement(Harness),React.createElement(SceneHarness)));
 });
 const end=page.locator('.timeline-clip .timeline-trim-handle.end');await expect(end).toBeAttached();
 let box=await end.boundingBox();await page.mouse.move(box.x+4,box.y+20);await page.mouse.down();await page.mouse.move(box.x-100,box.y+20,{steps:8});await page.mouse.up();
 expect((await page.evaluate(()=>globalThis.result)).duration).toBeLessThan(6000);
 const start=page.locator('.timeline-clip .timeline-trim-handle.start');box=await start.boundingBox();await page.mouse.move(box.x+4,box.y+20);await page.mouse.down();await page.mouse.move(box.x+104,box.y+20,{steps:8});await page.mouse.up();
 expect((await page.evaluate(()=>globalThis.result)).start).toBeGreaterThan(1000);
 const cueEnd=page.locator('.timeline-cue .timeline-trim-handle.end');
 await cueEnd.click();expect(await page.evaluate(()=>globalThis.cueResult)).toBeUndefined();
 box=await cueEnd.boundingBox();await page.mouse.move(box.x+4,box.y+20);await page.mouse.down();await page.mouse.move(box.x+104,box.y+20,{steps:8});await page.mouse.up();
 expect((await page.evaluate(()=>globalThis.cueResult)).duration).toBeGreaterThan(2000);
 const cueStart=page.locator('.timeline-cue .timeline-trim-handle.start');box=await cueStart.boundingBox();await page.mouse.move(box.x+4,box.y+20);await page.mouse.down();await page.mouse.move(box.x+54,box.y+20,{steps:8});await page.mouse.up();
 expect((await page.evaluate(()=>globalThis.cueResult)).start).toBeGreaterThan(1000);
 console.log('通过：素材与无时长 OBS 场景左右拖动均提交修剪；单击场景手柄不写入时长。');
} finally {await browser.close();}

