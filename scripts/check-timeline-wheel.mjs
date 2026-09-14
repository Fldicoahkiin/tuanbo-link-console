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
  const {useTimelineViewport}=await import('/src/link/components/useTimelineViewport.ts');
  function Harness(){const v=useTimelineViewport(120000);return React.createElement('div',{ref:v.viewportRef,onScroll:v.onScroll,'data-zoom':v.pixelsPerSecond,style:{width:500,height:150,overflow:'auto'}},React.createElement('div',{style:{width:v.contentWidth,height:100}},'timeline'));}
  createRoot(globalThis.document.getElementById('test')).render(React.createElement(Harness));
 });
 const viewport=page.locator('[data-zoom]');await expect(viewport).toBeVisible();await viewport.hover();
 await page.mouse.wheel(0,200);await expect.poll(()=>viewport.evaluate(el=>el.scrollLeft)).toBe(200);
 await page.mouse.wheel(0,-100);await expect.poll(()=>viewport.evaluate(el=>el.scrollLeft)).toBe(100);
 await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');
 await expect.poll(()=>viewport.getAttribute('data-zoom')).not.toBe('32');
 expect(errors).toEqual([]);console.log('通过：普通滚轮左右滚动，Ctrl 滚轮缩放。');
} finally {await browser.close();}
