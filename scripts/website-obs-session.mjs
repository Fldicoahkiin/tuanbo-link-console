import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { closeOwnedObsTest } from './close-owned-obs-test.mjs';

export async function startWebsiteObs(root, directory, OBSWebSocket) {
  const obsDirectory = join(directory, 'obs');
  for (const folder of ['bin', 'data', 'obs-plugins']) await cp(join('C:/Program Files/obs-studio', folder), join(obsDirectory, folder), { recursive: true });
  await cp(join(root, 'tools/obs/native-preview/tblink-realtime-preview.dll'), join(obsDirectory, 'obs-plugins/64bit/tblink-realtime-preview.dll'));
  const config = join(obsDirectory, 'config/obs-studio');
  for (const folder of ['basic/profiles/Website', 'basic/scenes', 'plugin_config/obs-websocket']) await mkdir(join(config, folder), { recursive: true });
  const settings = '[General]\nFirstRun=false\nEnableAutoUpdates=false\n[Basic]\nProfile=Website\nProfileDir=Website\nSceneCollection=Website\nSceneCollectionFile=Website\n';
  await writeFile(join(config, 'global.ini'), settings);
  await writeFile(join(config, 'user.ini'), settings + '[BasicWindow]\nPreviewEnabled=true\nSysTrayEnabled=false\n');
  await writeFile(join(config, 'basic/profiles/Website/basic.ini'), '[General]\nName=Website\n[Video]\nBaseCX=720\nBaseCY=1280\nOutputCX=720\nOutputCY=1280\nFPSType=0\nFPSCommon=30\n');
  await writeFile(join(config, 'basic/scenes/Website.json'), JSON.stringify({ name: 'Website', current_scene: '官网演示 A', current_program_scene: '官网演示 A', sources: ['官网演示 A', '官网演示 B'].map(name => ({ name, id: 'scene', settings: { items: [] } })), scene_order: [{ name: '官网演示 A' }, { name: '官网演示 B' }], version: 2 }));
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  await writeFile(join(config, 'plugin_config/obs-websocket/config.json'), JSON.stringify({ alerts_enabled: false, auth_required: false, first_load: false, server_enabled: true, server_port: port }));
  const executable = join(obsDirectory, 'bin/64bit/obs64.exe');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$p=Start-Process -FilePath ${quote(executable)} -WorkingDirectory ${quote(dirname(executable))} -ArgumentList @('--portable','--multi','--disable-updater','--disable-missing-files-check') -WindowStyle Hidden -PassThru; @{pid=$p.Id;started=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`;
  const launch = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  const identity = { ...JSON.parse(launch.stdout.replace(/^\uFEFF/, '')), executable };
  await writeFile(join(directory, 'owned-obs.json'), JSON.stringify(identity));
  const socket = new OBSWebSocket(), url = `ws://127.0.0.1:${port}`;
  // Wait for the owned process to initialize; never retry a failed runtime action.
  await new Promise(resolve => setTimeout(resolve, 10000));
  try {
    await socket.connect(url);
    for (const [scene, color, label] of [['官网演示 A', 4284493338, 'A / WIDE'], ['官网演示 B', 4286625850, 'B / CLOSE']]) {
      await socket.call('CreateInput', { sceneName: scene, inputName: `${scene}背景`, inputKind: 'color_source_v3', inputSettings: { color, width: 720, height: 1280 }, sceneItemEnabled: true });
      await socket.call('CreateInput', { sceneName: scene, inputName: `${scene}标题`, inputKind: 'text_gdiplus_v3', inputSettings: { text: label + '\nSCENE DEMO', font: { face: 'Arial', size: 64, style: 'Bold', flags: 1 }, color: 16777215 }, sceneItemEnabled: true });
    }
    return { socket, executable, url, close: async () => { await socket.disconnect(); await closeOwnedObsTest(identity); } };
  } catch (error) {
    await writeFile(join(directory, 'obs-start-failure.txt'), String(error.stack));
    await socket.disconnect();
    try { await closeOwnedObsTest(identity); } catch (closeError) { await writeFile(join(directory, 'obs-close-failure.txt'), closeError.message); }
    throw error;
  }
}

export async function resumeWebsiteObs(directory, OBSWebSocket) {
  const identity = JSON.parse(await readFile(join(directory, 'owned-obs.json'), 'utf8'));
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$p=Get-Process -Id ${identity.pid}; if($p.MainModule.FileName -ne ${quote(identity.executable)} -or $p.StartTime.ToUniversalTime().ToString('o') -ne ${quote(identity.started)}){throw 'Owned OBS identity changed'}; 'verified'`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  const settings = JSON.parse(await readFile(join(directory, 'obs/config/obs-studio/plugin_config/obs-websocket/config.json'), 'utf8'));
  const socket = new OBSWebSocket(), url = `ws://127.0.0.1:${settings.server_port}`; await socket.connect(url);
  const inputs = (await socket.call('GetInputList')).inputs;
  for (const [scene, color, label] of [['官网演示 A', 4284493338, 'A / WIDE'], ['官网演示 B', 4286625850, 'B / CLOSE']]) {
    if (!inputs.some(input => input.inputName === `${scene}背景`)) await socket.call('CreateInput', { sceneName: scene, inputName: `${scene}背景`, inputKind: 'color_source_v3', inputSettings: { color, width: 720, height: 1280 }, sceneItemEnabled: true });
    if (!inputs.some(input => input.inputName === `${scene}标题`)) await socket.call('CreateInput', { sceneName: scene, inputName: `${scene}标题`, inputKind: 'text_gdiplus_v3', inputSettings: { text: label + '\nSCENE DEMO', font: { face: 'Arial', size: 64, style: 'Bold', flags: 1 }, color: 16777215 }, sceneItemEnabled: true });
  }
  return { socket, executable: identity.executable, url, close: async () => { await socket.disconnect(); await closeOwnedObsTest(identity); } };
}
