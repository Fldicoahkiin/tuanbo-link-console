import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { OBSWebSocket } = require('obs-websocket-js');
const ffmpeg = require('ffmpeg-static');
const folder = resolve('acceptance-20260914-obs-realtime/native-seek'); await mkdir(folder, {recursive:true});
const video = resolve(folder, 'frame-test.mp4');
function ff(args,input) { const result=spawnSync(ffmpeg,args,{input,maxBuffer:30_000_000,windowsHide:true});if(result.status!==0)throw Error(result.stderr.toString());return result.stdout; }
ff(['-v','error','-y','-f','lavfi','-i','testsrc2=size=128x72:rate=30','-t','10','-c:v','libx264','-g','1','-pix_fmt','yuv420p',video]);
const frames=ff(['-v','error','-i',video,'-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
const pid=Number(process.argv[2]); if(!Number.isInteger(pid)||pid<=0)throw Error('需要隔离 OBS PID');
const ws=new OBSWebSocket();await ws.connect('ws://127.0.0.1:4457');
const scene='团播联动台·素材·原生定位验收', source=scene+'·来源';
const original=(await ws.call('GetCurrentProgramScene')).sceneName;
const canvas=await ws.call('GetVideoSettings');
async function seek(ms){const packet=Buffer.alloc(1040);packet.writeUInt32LE(0x31534254);packet.writeUInt32LE(1,4);packet.writeBigInt64LE(BigInt(ms),8);packet.write(source,16,'utf8');
 await new Promise((ok,fail)=>{const socket=createConnection(`\\\\.\\pipe\\tblink-obs-seek-${pid}`);let bytes=Buffer.alloc(0);socket.setTimeout(2000,()=>socket.destroy(Error('timeout')));socket.on('error',fail);socket.on('connect',()=>socket.write(packet));socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>=4){socket.end(Buffer.from([1]));if(bytes.readUInt32LE())fail(Error('native rejected'));else ok();}});});}
function match(pixels){let best={frame:-1,error:Infinity};const size=128*72*3;for(let frame=0;frame<frames.length/size;frame++){let error=0;for(let i=0;i<size;i+=9)error+=Math.abs(pixels[i]-frames[frame*size+i]);if(error<best.error)best={frame,error};}return best;}
try{
 await ws.call('CreateScene',{sceneName:scene});
 await ws.call('CreateInput',{sceneName:scene,inputName:source,inputKind:'ffmpeg_source',inputSettings:{local_file:video,is_local_file:true,restart_on_activate:false,close_when_inactive:false}});
 await ws.call('SetCurrentProgramScene',{sceneName:scene});
 await ws.call('TriggerMediaInputAction',{inputName:source,mediaAction:'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'});
 await new Promise(r=>setTimeout(r,500));
 const rows=[];
 for(const ms of [1000,5000,2000,7500,2000]){const start=performance.now();await seek(ms);const acknowledgedMs=performance.now()-start;await new Promise(r=>setTimeout(r,100));
 const shot=await ws.call('GetSourceScreenshot',{sourceName:scene,imageFormat:'png',imageWidth:canvas.baseWidth,imageHeight:canvas.baseHeight});
 const png=Buffer.from(shot.imageData.split(',')[1],'base64');await writeFile(resolve(folder,`${rows.length}-${ms}.png`),png);
 const pixels=ff(['-v','error','-i','pipe:0','-vf','crop=128:72:0:0','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],png);
 rows.push({ms,acknowledgedMs,...match(pixels),status:await ws.call('GetMediaInputStatus',{inputName:source})});}
 console.log(JSON.stringify(rows,null,2));await writeFile(resolve(folder,'result.json'),JSON.stringify(rows,null,2));
 if(rows.some(row=>row.frame!==Math.round(row.ms*30/1000)))throw Error('OBS 正式场景截图与目标帧不符');
}finally{await ws.call('SetCurrentProgramScene',{sceneName:original});await ws.call('RemoveInput',{inputName:source});await ws.call('RemoveScene',{sceneName:scene});await ws.disconnect();}
