// Long run of the formal (native) player on Windows: the songs of one project play in a loop with
// real OBS, and their timecode goes to a loopMIDI port whose input mtc-receiver.ps1 decodes. One app
// instance runs the whole time, so memory and handles are measured across the run. Optionally the run
// shares the machine: after each segment it stops, disconnects OBS, minimises the window and gives up a
// lock file for a break, then waits for the lock again. Run it through run-longrun.ps1 (hard time
// limit and cleanup); summarise with summary.mjs. Options (minutes):
//   --project <.tblink beside its media>  --out <dir>  --stamp <id>  [--port "TBLINK SOAK MTC"]
//   [--play 240] [--segment 30] [--break 10] [--cap 360] [--volume 10]
//   [--lock <lock file held at start> --lock-label <its content> --discarded <dir for released locks>]
import { createRequire } from 'node:module';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../..');
const require = createRequire(join(repo, 'apps/desktop/package.json'));
const { _electron: electron } = require('@playwright/test');
const { default: OBSWebSocket, EventSubscription } = require('obs-websocket-js');
const electronExecutable = require('electron');

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined) throw new Error(`参数不完整：${key ?? ''}`);
  options[key.slice(2)] = value;
}
const { project: source, out, stamp } = options;
if (!source || !out || !stamp) throw new Error('需要 --project、--out 和 --stamp');
const minutes = (name, fallback) => Number(options[name] ?? fallback) * 60000;
const playTarget = minutes('play', 240), segmentMs = minutes('segment', 30), breakMs = minutes('break', 10), capMs = minutes('cap', 360);
const PORT = options.port ?? 'TBLINK SOAK MTC', volume = Number(options.volume ?? 10);
const started = Date.now(), deadline = started + capMs;
// A file named `stop` in the out dir ends the run at the next check, through the normal cleanup.
const stopRequested = () => existsSync(join(out, 'stop'));
mkdirSync(out, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = () => new Date().toISOString();
const record = (file, value) => appendFileSync(join(out, file), JSON.stringify({ at: iso(), t: Date.now() - started, ...value }) + '\n');
const note = message => { record('events.jsonl', { kind: 'note', message }); console.log(`${iso()} ${message}`); };

// Without --lock the run keeps the machine; with it, any other *.lock beside it means the machine is busy.
const LOCK = options.lock ?? null, lockLabel = options['lock-label'] ?? `long run ${stamp}`;
const holdsLock = () => LOCK === null || (existsSync(LOCK) && readFileSync(LOCK, 'utf8').includes(lockLabel));
const releaseLock = () => { if (LOCK && holdsLock()) renameSync(LOCK, join(options.discarded ?? dirname(LOCK), `${basename(LOCK)}.${iso().replace(/[:.]/g, '-')}`)); };
const tryLock = () => {
  if (!LOCK) return null;
  const others = readdirSync(dirname(LOCK)).filter(name => name.endsWith('.lock'));
  if (others.length) return others;
  writeFileSync(LOCK, lockLabel); return null;
};
if (!holdsLock()) throw new Error('启动时没有持有锁文件');

// MTC receiver on the loopMIDI test port's input.
const mtcLog = join(out, 'mtc.jsonl');
const receiver = spawn('pwsh', ['-NoProfile', '-File', join(here, 'mtc-receiver.ps1'), '-Name', PORT, '-HoldSeconds', String(Math.ceil(capMs / 1000) + 900), '-Log', mtcLog], { stdio: 'ignore', windowsHide: true });
await wait(3000);
if (!existsSync(mtcLog) || !readFileSync(mtcLog, 'utf8').includes('"opened"')) { releaseLock(); throw new Error(`MTC 接收器没有打开：${existsSync(mtcLog) ? readFileSync(mtcLog, 'utf8') : '无日志'}`); }
const mtcStatus = () => { try { return JSON.parse(readFileSync(`${mtcLog}.status.json`, 'utf8')); } catch (error) { return { error: String(error) }; } };

// Project copy beside the media (relative paths): songs run on to the next one, at a quiet volume.
// run-longrun.ps1 moves the copy into the out dir afterwards.
const file = join(dirname(source), `长时间运行-${stamp}.tblink`);
const project = JSON.parse(readFileSync(source, 'utf8'));
project.projectId = randomUUID(); project.name = `长时间运行 ${stamp}`;
for (const item of project.rundown) if (item.playback) item.playback = { ...item.playback, endAction: 'next', volume };
writeFileSync(file, JSON.stringify(project, null, 2));
const titles = project.rundown.filter(item => item.enabled !== false).map(item => item.title);
const firstItemId = project.rundown.find(item => item.enabled !== false).id, first = titles[0], finalItemId = project.rundown.filter(item => item.enabled !== false).at(-1).id;

// Isolated copy of the operator's profile; the real profile is never written.
const userData = join(out, 'userdata'), real = join(process.env.APPDATA, '团播联动台');
mkdirSync(join(userData, 'link-integrations'), { recursive: true });
for (const name of ['profile.json', 'ma2-network.json', 'secrets.json']) copyFileSync(join(real, 'link-integrations', name), join(userData, 'link-integrations', name));
copyFileSync(join(real, 'Local State'), join(userData, 'Local State'));
const ma2Path = join(userData, 'link-integrations', 'ma2-network.json'), ma2 = JSON.parse(readFileSync(ma2Path, 'utf8'));
if (ma2.active) ma2.active.autoConnect = false;
for (const entry of ma2.profiles ?? []) entry.autoConnect = false;
writeFileSync(ma2Path, JSON.stringify(ma2, null, 2));
const copyTree = (from, to) => { mkdirSync(to, { recursive: true }); for (const entry of readdirSync(from, { withFileTypes: true })) (entry.isDirectory() ? copyTree : copyFileSync)(join(from, entry.name), join(to, entry.name)); };
copyTree(join(real, 'Local Storage'), join(userData, 'Local Storage'));
const profilePath = join(userData, 'link-integrations', 'profile.json'), profile = JSON.parse(readFileSync(profilePath, 'utf8'));
profile.internalPlayer = { ...profile.internalPlayer, audioEngine: 'native', nativeAudioOutputDeviceId: 'default', audioSampleRate: 48000 };
profile.obs.autoConnectOnLaunch = false;
const mtcProfile = profile.midiPortProfiles.find(entry => entry.id === profile.internalPlayer?.mtcOutputPortProfileId);
if (!mtcProfile) throw new Error('现场配置没有时间码输出端口');
mtcProfile.portName = PORT;
writeFileSync(profilePath, JSON.stringify(profile, null, 2));

// The test's own OBS observer: program changes with the song position they happened at.
const obsConfig = JSON.parse(readFileSync(join(process.env.APPDATA, 'obs-studio/plugin_config/obs-websocket/config.json'), 'utf8'));
const obs = new OBSWebSocket();
await obs.connect(`ws://127.0.0.1:${obsConfig.server_port}`, obsConfig.auth_required ? obsConfig.server_password : undefined, { eventSubscriptions: EventSubscription.Scenes });
const originalProgram = (await obs.call('GetCurrentProgramScene')).currentProgramSceneName;
let phase = 'starting', segment = 0, last = null;
const plays = [];
obs.on('CurrentProgramSceneChanged', event => {
  const now = Date.now(), playing = last?.status === 'playing';
  record('obs.jsonl', { phase, segment, scene: event.sceneName, itemId: last?.itemId ?? null, play: plays.length, pos: playing ? Math.round(last.positionMs + now - last.wall) : null });
});

const app = await electron.launch({ executablePath: electronExecutable,
  args: [`--user-data-dir=${userData}`, join(repo, 'apps/desktop/out/main/index.cjs')], cwd: join(repo, 'apps/desktop'),
  env: { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' } });
const mainPid = app.process().pid;
const page = await app.firstWindow(); page.setDefaultTimeout(20000);
await app.evaluate(({ dialog }) => {
  const original = dialog.showMessageBox.bind(dialog);
  globalThis.__startChecks = [];
  dialog.showMessageBox = (...args) => { const options = args.at(-1);
    if (options?.title === '开播前检查') { globalThis.__startChecks.push(options.detail); return Promise.resolve({ response: 0, checkboxChecked: false }); }
    return original(...args); };
});
const pageErrors = []; page.on('pageerror', error => { pageErrors.push(error.message); record('events.jsonl', { kind: 'pageerror', message: error.message }); });
const native = () => page.evaluate(() => globalThis.tbLink.getNativePlaybackStatus());
const header = () => page.locator('.player-now').innerText({ timeout: 5000 }).catch(error => `读取失败：${error.message}`);
const seenLogs = new Set(); let infoLogs = 0;

async function processes() {
  // This instance only: its Electron processes carry its user data directory, its engines run from this checkout.
  const engines = `${repo}\\*`;
  const script = `$names = @{}
Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'tblink-playback.exe' -and $_.ExecutablePath -like '${engines}') -or ($_.Name -eq 'electron.exe' -and $_.CommandLine -like '*${userData}*') -or $_.Name -eq 'obs64.exe' } | ForEach-Object {
  $type = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } elseif ($_.Name -eq 'electron.exe') { 'main' } elseif ($_.Name -eq 'tblink-playback.exe') { ($_.CommandLine -replace '^.*tblink-playback\\.exe"?\\s*', '').Trim() } else { '' }
  $names[[int]$_.ProcessId] = ($_.Name -replace '\\.exe$', '') + $(if ($type) { '/' + $type } else { '' }) }
Get-Process -Id @($names.Keys) -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $names[$_.Id]; ws = $_.WorkingSet64; priv = $_.PrivateMemorySize64; handles = $_.HandleCount; threads = $_.Threads.Count; cpuSeconds = $_.TotalProcessorTime.TotalSeconds } } | ConvertTo-Json -Compress`;
  return new Promise(resolve => execFile('pwsh', ['-NoProfile', '-Command', script], { timeout: 20000, windowsHide: true }, (error, stdout) => {
    if (error) resolve({ error: error.message }); else { try { const value = JSON.parse(stdout); resolve(Array.isArray(value) ? value : [value]); } catch (parse) { resolve({ error: String(parse) }); } }
  }));
}
async function sample() {
  const [metrics, external, status, logs, now] = await Promise.all([
    app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, cpu: m.cpu.percentCPUUsage, ws: m.memory.workingSetSize, priv: m.memory.privateBytes }))).catch(error => ({ error: error.message })),
    processes(), native().catch(error => ({ error: error.message })),
    page.evaluate(() => globalThis.tbLink.queryLogs({ limit: 500 })).catch(error => ({ error: error.message })), header()]);
  let fresh = [];
  if (Array.isArray(logs)) for (const entry of logs) {
    if (seenLogs.has(entry.id)) continue; seenLogs.add(entry.id);
    if (entry.level === 'info') infoLogs++; else fresh.push({ level: entry.level, device: entry.device ?? null, message: entry.message, at: entry.timestamp });
  }
  for (const entry of fresh) record('logs.jsonl', { phase, segment, ...entry });
  record('samples.jsonl', { phase, segment, metrics, external, header: now, newWarnings: fresh.length, infoLogs, logStoreSize: Array.isArray(logs) ? logs.length : null,
    native: status && !status.error ? { status: status.status, itemId: status.itemId, positionMs: Math.round(status.positionMs), offsetMs: status.offsetMs, underruns: status.underruns,
      mtcSent: status.mtcSent, mtcInterruptions: status.mtcInterruptions, mtcError: status.mtcError, audioError: status.audioError, enginePid: status.enginePid } : status,
    mtc: mtcStatus() });
}

// The current program's card only selects, so it restarts from the player button; any other song from its card's number button.
async function play(itemId) {
  const card = page.locator(`article.p1-media-card[data-program-id="${itemId}"]`);
  if (await card.evaluate(element => element.classList.contains('is-current'))) await page.locator('.player-transport .primary-button').click();
  else await card.locator('.rundown-index').click();
}
async function stopPlayback() {
  const button = page.getByRole('button', { name: '停止播放', exact: true });
  if (await button.isEnabled({ timeout: 2000 }).catch(() => false)) await button.click();
  await wait(3000);
}
async function windowState(action) { await app.evaluate(({ BrowserWindow }, value) => { const win = BrowserWindow.getAllWindows()[0]; if (value === 'minimize') win?.minimize(); else { win?.restore(); win?.focus(); } }, action); }
async function connectObs() {
  const result = await page.evaluate(() => globalThis.tbLink.connectObs()).then(value => value.status, error => `失败：${error.message}`);
  record('events.jsonl', { kind: 'obs-connect', result, segment }); return result;
}

// One poll every 250 ms: per-play statistics, timecode drift every 5 s, restarts at the end of the rundown.
let playedMs = 0, notPlayingSince = null, lastDrift = 0, sampling = null, receptionChecked = false;
function track(status) {
  const now = Date.now();
  if (!status) { last = null; return; }
  const current = plays.at(-1);
  const fresh = status.status === 'playing' && (!current || current.itemId !== status.itemId || current.sessionId !== status.sessionId || status.positionMs < current.lastPosition - 1000);
  if (fresh) {
    if (current) record('plays.jsonl', current);
    plays.push({ index: plays.length, segment, itemId: status.itemId, sessionId: status.sessionId, startedAt: iso(), firstPosition: Math.round(status.positionMs), lastPosition: status.positionMs,
      underruns: status.underruns, mtcSent: status.mtcSent, mtcInterruptions: status.mtcInterruptions, mtcErrors: [], audioError: null, endStatus: null });
  }
  const play = plays.at(-1);
  if (play && play.itemId === status.itemId && play.sessionId === status.sessionId) {
    if (status.status === 'playing') { play.lastPosition = status.positionMs; play.underruns = status.underruns; play.mtcSent = status.mtcSent; play.mtcInterruptions = status.mtcInterruptions; }
    if (status.mtcError && !play.mtcErrors.includes(status.mtcError)) play.mtcErrors.push(status.mtcError);
    if (status.audioError) play.audioError = status.audioError;
    play.endStatus = status.status;
  }
  if (last?.status === 'playing' && status.status === 'playing') playedMs += now - last.wall;
  if (status.status === 'playing' && now - lastDrift >= 5000) {
    lastDrift = now; const mtc = mtcStatus();
    if (mtc.lastTcAtUnixMs && now - mtc.lastTcAtUnixMs < 1000) record('drift.jsonl', { itemId: status.itemId, driftMs: Math.round(mtc.lastTcMs + now - mtc.lastTcAtUnixMs - status.offsetMs - status.positionMs) });
    else record('drift.jsonl', { itemId: status.itemId, driftMs: null, mtcAgeMs: mtc.lastTcAtUnixMs ? Math.round(now - mtc.lastTcAtUnixMs) : null });
  }
  last = { ...status, wall: now };
}

async function runSegment() {
  const segmentStart = Date.now(); phase = 'playing';
  await windowState('restore'); note(`第 ${segment} 段开始；OBS ${await connectObs()}`);
  await play(firstItemId); notPlayingSince = null;
  let nextSample = 0;
  while (Date.now() - segmentStart < segmentMs && playedMs < playTarget && Date.now() < deadline && !stopRequested()) {
    const status = await native().catch(error => { record('events.jsonl', { kind: 'poll-failed', message: error.message }); return null; });
    track(status);
    // Sampling runs beside the 250 ms poll so a slow process query does not stall it.
    if (Date.now() >= nextSample && !sampling) { nextSample = Date.now() + 30000; sampling = sample().catch(error => note(`采样失败：${error.message}`)).finally(() => { sampling = null; }); }
    // Early delivery check: the engine counts full frames and quarter frames, the receiver quarter frames.
    if (!receptionChecked && playedMs >= 90000) {
      receptionChecked = true;
      const sent = plays.reduce((sum, entry) => sum + (entry.mtcSent ?? 0), 0), received = mtcStatus().totalQf ?? 0;
      record('events.jsonl', { kind: 'reception-check', sent, received, plays: plays.length });
      note(`时间码送达核对：引擎发送 ${sent}，接收端四分之一帧 ${received}`);
      if (!sent || received < sent * 0.95) throw new Error(`时间码送达不足：引擎发送 ${sent}，接收端 ${received}`);
    }
    if (status && status.status !== 'playing' && status.status !== 'preparing') {
      notPlayingSince ??= Date.now();
      if (Date.now() - notPlayingSince > 3000) {
        const expected = status.itemId === finalItemId && ['stopped', 'ended', 'paused', 'ready'].includes(status.status) && !status.audioError;
        record('events.jsonl', { kind: expected ? 'rundown-end' : 'unexpected-stop', itemId: status.itemId, status: status.status, audioError: status.audioError, header: await header() });
        if (!expected) await page.screenshot({ path: join(out, `unexpected-${plays.length}.png`) }).catch(() => undefined);
        await play(firstItemId); notPlayingSince = null;
      }
    } else notPlayingSince = null;
    await wait(250);
  }
  await sampling; await stopPlayback(); track(await native().catch(() => null)); await sample();
  note(`第 ${segment} 段结束；已播放 ${Math.round(playedMs / 60000)} 分钟`);
}

let failure = null;
try {
  await page.waitForFunction(() => Boolean(globalThis.tbLink));
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
  // The start page offers 打开工程 directly; with a project already open it sits in the project menu.
  const openButton = page.getByRole('button', { name: '打开工程', exact: true }), projectMenu = page.locator('summary[aria-label="工程菜单"]');
  await openButton.or(projectMenu).first().waitFor({ timeout: 90000 });
  if (await openButton.count() === 0) await projectMenu.click();
  await page.getByRole('button', { name: '打开工程', exact: true }).click({ timeout: 90000 });
  await page.getByText(first, { exact: true }).first().waitFor();
  while (playedMs < playTarget && Date.now() < deadline && !stopRequested()) {
    segment++;
    await runSegment();
    if (playedMs >= playTarget || Date.now() >= deadline || stopRequested()) break;
    // Hand the machine to other users of the lock: no playback, no OBS connection, window out of the way.
    await page.evaluate(() => globalThis.tbLink.disconnectObs()).catch(error => note(`断开 OBS 失败：${error.message}`));
    await windowState('minimize'); phase = 'idle'; releaseLock(); note(LOCK ? '已释放锁' : '段间休息');
    const idleUntil = Date.now() + breakMs;
    while (Date.now() < idleUntil && Date.now() < deadline && !stopRequested()) { await sample(); await wait(30000); }
    phase = 'waiting';
    let busy = tryLock();
    while (busy && Date.now() < deadline && !stopRequested()) { record('events.jsonl', { kind: 'lock-busy', locks: busy }); await sample(); await wait(30000); busy = tryLock(); }
    if (busy) { note('等锁超过总时限，结束'); break; }
    note(LOCK ? '重新取得锁' : '休息结束');
  }
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  record('events.jsonl', { kind: 'failure', failure });
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined);
} finally {
  phase = 'closing';
  if (plays.length) record('plays.jsonl', plays.at(-1));
  await sample().catch(error => note(`最后采样失败：${error.message}`));
  const startChecks = await app.evaluate(() => globalThis.__startChecks).catch(error => `读取失败：${error.message}`);
  if (holdsLock()) await stopPlayback().catch(error => note(`停止失败：${error.message}`));
  await Promise.race([app.close(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('关闭超时')), 20000))])
    .catch(error => { note(`关闭失败：${error.message}`); try { execFileSync('taskkill', ['/PID', String(mainPid), '/T', '/F']); } catch (kill) { note(`结束测试实例失败：${kill}`); } });
  writeFileSync(`${mtcLog}.stop`, 'stop'); await wait(3000);
  // Only touch OBS while the machine is ours.
  if (holdsLock()) await obs.call('SetCurrentProgramScene', { sceneName: originalProgram }).catch(error => note(`恢复播出场景失败：${error.message}`));
  else note('结束时未持有 GUI 锁，未恢复播出场景');
  await Promise.race([obs.disconnect(), wait(5000)]);
  if (receiver.exitCode === null) receiver.kill();
  writeFileSync(join(out, 'result.json'), JSON.stringify({ stamp, project: source, copy: file, port: PORT, startedAt: new Date(started).toISOString(), endedAt: iso(), wallMinutes: Math.round((Date.now() - started) / 60000),
    playedMinutes: Math.round(playedMs / 60000), segments: segment, plays: plays.length, failure, pageErrors, startChecks, originalProgram }, null, 1));
  releaseLock();
}
process.exit(0);
