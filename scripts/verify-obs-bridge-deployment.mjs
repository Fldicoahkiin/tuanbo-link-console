import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

// No installed plugin, user OBS profile, compiler or user credentials are used by the test OBS.
if (process.platform !== 'win32') throw new Error('Requires native Windows');
const root = process.cwd();
const sourceObs = process.argv[2];
const sourceDll = process.argv[3];
if (!sourceObs || !sourceDll) throw new Error('Usage: node scripts/verify-obs-bridge-deployment.mjs <OBS directory> <packaged DLL>');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const viteRequire = createRequire(require.resolve('electron-vite/package.json'));
const { build } = viteRequire('esbuild');
const OBSWebSocket = require('obs-websocket-js').default;
const run = promisify(execFile);
const ps = async (script) => run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')], { windowsHide: true });
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
await mkdir(join(root, 'artifacts'), { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'tblink-obs-release-'));
const obsDirectory = join(directory, 'obs');
console.log(`Isolated deployment: ${directory}`);
for (const name of ['bin', 'data', 'obs-plugins']) {
  await cp(join(resolve(sourceObs), name), join(obsDirectory, name), {
    recursive: true,
    filter: (path) => basename(path).toLowerCase() !== 'tblink-realtime-preview.dll'
  });
}
const config = join(obsDirectory, 'config/obs-studio');
await mkdir(join(config, 'basic/profiles/Bridge'), { recursive: true });
await mkdir(join(config, 'basic/scenes'), { recursive: true });
await mkdir(join(config, 'plugin_config/obs-websocket'), { recursive: true });
const global = '[General]\nFirstRun=false\nLastVersion=537001986\nEnableAutoUpdates=false\n\n[Basic]\nProfile=Bridge\nProfileDir=Bridge\nSceneCollection=Bridge\nSceneCollectionFile=Bridge\n';
await writeFile(join(config, 'global.ini'), global);
await writeFile(join(config, 'user.ini'), `${global}\n[BasicWindow]\nPreviewEnabled=true\nSysTrayEnabled=false\n`);
await writeFile(join(config, 'basic/profiles/Bridge/basic.ini'), '[General]\nName=Bridge\n[Video]\nBaseCX=640\nBaseCY=360\nOutputCX=640\nOutputCY=360\nFPSType=0\nFPSCommon=30\n[Output]\nMode=Simple\n');
await writeFile(join(config, 'basic/scenes/Bridge.json'), JSON.stringify({ name: 'Bridge', current_scene: 'Bridge', current_program_scene: 'Bridge', sources: [{ name: 'Bridge', id: 'scene', settings: { items: [] } }], scene_order: [{ name: 'Bridge' }], version: 2 }));
const port = 19000 + Math.floor(Math.random() * 10000);
await writeFile(join(config, 'plugin_config/obs-websocket/config.json'), JSON.stringify({ alerts_enabled: false, auth_required: false, first_load: false, server_enabled: true, server_password: '', server_port: port }));
await build({ stdin: { contents: `export { installObsLiveBridge } from './apps/desktop/src/main/link/obs-live-install'; export { ObsLivePreview } from './apps/desktop/src/main/link/obs-live-preview';`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', loader: { '.lua': 'text' }, outfile: join(directory, 'deployment.cjs') });
const { installObsLiveBridge, ObsLivePreview } = require(join(directory, 'deployment.cjs'));
const originalProgramData = process.env.ProgramData;
process.env.ProgramData = join(directory, 'program-data');
await installObsLiveBridge(resolve(sourceDll));
if (originalProgramData === undefined) delete process.env.ProgramData;
else process.env.ProgramData = originalProgramData;
const pluginRoot = join(directory, 'program-data/obs-studio/plugins');
const pluginBin = join(pluginRoot, 'tblink-realtime-preview/bin/64bit');
const executable = join(obsDirectory, 'bin/64bit/obs64.exe');
const launch = await ps(`$env:OBS_PLUGINS_PATH=${quote(pluginBin)}; $env:OBS_PLUGINS_DATA_PATH=${quote(pluginRoot)}; $p=Start-Process -FilePath ${quote(executable)} -WorkingDirectory ${quote(join(obsDirectory, 'bin/64bit'))} -ArgumentList @('--portable','--multi','--disable-updater','--disable-missing-files-check') -WindowStyle Hidden -PassThru; @{pid=$p.Id;started=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`);
const identity = JSON.parse(launch.stdout.replace(/^\uFEFF/, ''));
const client = new ObsLivePreview(() => Promise.resolve(identity.pid));
const socket = new OBSWebSocket();
let connected = false;
try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    const logs = await readdir(join(config, 'logs')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of logs) {
      if ((await readFile(join(config, 'logs', name), 'utf8')).includes('Startup complete')) ready = true;
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Isolated OBS startup did not complete');
  await socket.connect(`ws://127.0.0.1:${port}`); connected = true;
  const frames = [];
  for (let i = 0; i < 3; i++) {
    const frame = await client.next(`ws://127.0.0.1:${port}`);
    if (frame.width !== 640 || frame.height !== 360 || frame.rgba.byteLength !== 640 * 360 * 4) throw new Error('Unexpected frame dimensions');
    frames.push({ width: frame.width, height: frame.height, sequence: frame.sequence, bytes: frame.rgba.byteLength });
  }
  const modules = await ps(`(Get-Process -Id ${identity.pid} -ErrorAction Stop).Modules | Where-Object {$_.ModuleName -eq 'tblink-realtime-preview.dll'} | ForEach-Object {$_.FileName}`);
  const loaded = modules.stdout.trim();
  if (resolve(loaded).toLowerCase() !== join(pluginBin, 'tblink-realtime-preview.dll').toLowerCase()) throw new Error(`Wrong plugin loaded: ${loaded}`);
  const report = { passed: true, executable, plugin: loaded, packagedSha256: createHash('sha256').update(await readFile(resolve(sourceDll))).digest('hex'), frames, scope: 'Fresh portable OBS/config with packaged plugin; system-installed plugin excluded. UAC desktop interaction is not simulated.' };
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('Deployment verification failed:', error);
  throw error;
} finally {
  client.close();
  if (!connected) { await socket.connect(`ws://127.0.0.1:${port}`); connected = true; }
  const stream = await socket.call('GetStreamStatus');
  const record = await socket.call('GetRecordStatus');
  assertIdle(stream, record);
  await socket.disconnect();
  const close = await ps(`$p=Get-Process -Id ${identity.pid} -ErrorAction Stop; if(-not $p.MainModule.FileName.Equals(${quote(executable)},[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().ToString('o') -ne ${quote(identity.started)}){throw 'Process identity changed'};
Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class CloseBridgeTest { public delegate bool E(IntPtr h,IntPtr p); [DllImport("user32.dll")] static extern bool EnumWindows(E e,IntPtr p); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n); [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); public static bool Close(uint pid){ bool sent=false;EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);var s=new StringBuilder(512);GetWindowText(h,s,512);if(id==pid && s.ToString().StartsWith("OBS ")){sent=PostMessage(h,16,IntPtr.Zero,IntPtr.Zero);return false;}return true;},IntPtr.Zero);return sent;}}';
if(-not [CloseBridgeTest]::Close(${identity.pid})){throw 'OBS refused normal close'}; if(-not $p.WaitForExit(15000)){throw 'OBS did not exit; process retained'}`);
  if (close.stderr) console.log(close.stderr);
}

function assertIdle(stream, record) {
  if (stream.outputActive || record.outputActive) throw new Error('Isolated OBS output is active; refusing to close');
}
