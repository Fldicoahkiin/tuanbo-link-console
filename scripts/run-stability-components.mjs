import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const seconds = Number(process.argv[2] ?? 21600);
if (process.platform !== 'win32' || !Number.isInteger(seconds) || seconds < 30 || seconds > 21600) throw new Error('需要 Windows 和 30..21600 秒时长');
const directory = join(workspace, 'artifacts', `components-soak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(directory, { recursive: true });
const state = { status: 'running', startedAt: new Date().toISOString(), seconds, runnerPid: process.pid,
  applicationAcceptance: false, physicalAcceptance: false,
  scope: '并行测量原生 WASAPI/MIDI 原型与独立 OBS 四路 4K、八层、16 场景；不是正式播放器完整节目验收。',
  jobs: {}, failures: [] };
const save = () => writeFileSync(join(directory, 'run.json'), JSON.stringify(state, null, 2));
save(); console.log(directory);
function start(name, args, extraEnv = {}, onLine) {
  const output = createWriteStream(join(directory, `${name}.log`));
  const child = spawn(process.execPath, args, { cwd: workspace, env: { ...process.env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  state.jobs[name] = { pid: child.pid, status: 'running', startedAt: new Date().toISOString() }; save();
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  let buffer = '';
  if (onLine) child.stdout.on('data', data => {
    buffer += data.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      onLine(line);
    }
  });
  output.on('error', error => { state.failures.push(`${name} log: ${error.message}`); save(); });
  return new Promise(resolveJob => {
    child.on('error', error => { state.failures.push(`${name}: ${error.message}`); save(); });
    child.on('close', (code, signal) => {
      output.end(); Object.assign(state.jobs[name], { status: code === 0 ? 'passed' : 'failed', code, signal, finishedAt: new Date().toISOString() });
      save(); resolveJob(code);
    });
  });
}
let hostJob;
const nativeJob = start('native', [resolve(workspace, 'node_modules/vitest/vitest.mjs'), 'run', 'apps/desktop/src/main/link/native-playback-soak.test.ts'], { TBLINK_NATIVE_SOAK_SECONDS: String(seconds) });
const obsJob = start('obs', ['scripts/verify-obs-video-load.mjs', 'C:\\Program Files\\obs-studio', 'artifacts/stability-fixture-9QPbsu/four-4k/stability.tblink', String(seconds)], {}, line => {
  if (!line.startsWith('{"event":"started"')) return;
  try {
    const event = JSON.parse(line);
    if (event.event !== 'started' || hostJob) return;
    state.jobs.obs.evidenceDirectory = event.directory; save();
    hostJob = start('host', ['scripts/measure-stability-host.mjs', event.identityFile, String(seconds)]);
  } catch (error) { state.failures.push(`OBS startup metadata: ${String(error)}`); save(); }
});
const codes = await Promise.all([nativeJob, obsJob]);
if (hostJob) codes.push(await hostJob); else state.failures.push('未启动主机资源采样');
state.status = codes.every(code => code === 0) && !state.failures.length ? 'passed' : 'failed';
state.finishedAt = new Date().toISOString(); save();
process.exitCode = state.status === 'passed' ? 0 : 1;
