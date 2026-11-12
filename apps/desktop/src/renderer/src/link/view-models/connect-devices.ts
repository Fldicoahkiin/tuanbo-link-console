import { expectedMa2Shows, ma2ShowMismatch, toUserErrorMessage, type LinkLocalIntegrationDetection } from '@tb/core/link';
import { loopMidiStatusSchema, ma2NetworkStatusSchema, obsWebSocketUrlSchema, localObsConnectionResultSchema, type IntegrationProfile, type LinkProject } from '@tb/schema';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';
import { useIntegrationStore } from '../stores/integration-store';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { checkNetworkMa2, connectDiscoveredMa2, connectLocalMa2 } from '../stores/ma2-connection-store';
import { readMa2Method } from '../stores/ma2-mode-store';
import { currentShowGate } from '../stores/show-state-store';
import { useMa2NetworkStatusStore } from '../stores/ma2-network-status-store';
import { linkDesktopViewModel as desktop } from './link-desktop-view-model';
import { applyDetectedLightingMidiPorts, applyDetectedP1MidiPorts } from './local-integration-midi';
import { midiConnectionTargets, usesNativeMidiOutput } from './connection-targets';
import { obsPreviewSession } from './obs-preview-session';
import { assertAudioOutputAvailable } from './audio-output-route';

export type DeviceConnectionOptions = {
  draft: IntegrationProfile;
  password: string;
  project: LinkProject | null;
  readMidiPorts: () => Promise<readonly MidiPortSnapshot[]>;
  openMidiPorts: (ids: readonly string[], direction: 'input' | 'output') => Promise<string[]>;
  listenToP1: () => Promise<void>;
  onProfile: (profile: IntegrationProfile) => void;
  onDetection: (detection: LinkLocalIntegrationDetection) => void;
  onIssues: (issues: string[]) => void;
  onObsPassword?: (password: string) => void;
};
// Execution order. Saving the profile needs the MIDI inventory; OBS precedes
// lighting so a lighting fault does not hide whether video is usable.
const tasks = ['discovery', 'loop', 'midi', 'profile', 'obs', 'obs-inventory', 'preview', 'audio', 'p1', 'ma2-app', 'ma2', 'bridge', 'ma3d'];
const stepDeadlineMs = 60_000;
/** A dead saved address is followed by a search of up to 45 s and one more login. */
const ma2StepDeadlineMs = 100_000;
type ConnectionStep = <T>(id: string, label: string, operation: () => Promise<T>, detail?: string, deadlineMs?: number) => Promise<{ value: T } | null>;

/** The operation is not cancelled; the step fails and reports that it may still be running. */
function withDeadline<T>(operation: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超过 ${Math.round(deadlineMs / 1000)} 秒还没完成，可能仍在后台进行`)), deadlineMs);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

/** A Show saved under a new name is normal (2026-10-28): reported with the check, never a failed connection. */
async function projectMa2ShowNote(project: LinkProject | null): Promise<string | null> {
  const expected = project ? [...new Set(project.rundown.flatMap(item => expectedMa2Shows(project, item.id)))] : [];
  if (!expected.length) return null;
  return ma2ShowMismatch(expected, await desktop.getMa2CurrentShow());
}

async function startMaPrograms(profile: IntegrationProfile, detected: Partial<Record<'ma2' | 'ma3d', string>>, run: ConnectionStep, skip: (id: string, detail: string) => void, connect: () => Promise<void>): Promise<void> {
  const start = async (id: 'ma2' | 'ma3d'): Promise<boolean> => {
    const key = id === 'ma2' ? 'ma2-app' : 'ma3d';
    const label = id === 'ma2' ? 'MA2 onPC' : 'MA 3D';
    if (!profile[id]?.connectOnDemand) {
      const found = detected[id];
      skip(key, profile[id] ? '已关闭一键启动' : found ? `已找到 ${found}，但没有启用；在 MA2 设置里选择并启用后，一键连接才会启动它` : '没有设置本机程序，可以在 MA2 设置里选择');
      return true;
    }
    const result = await run(key, label, async () => {
      const snapshot = await desktop.startExternalApplication(id);
      useIntegrationStore.getState().setProcess(snapshot);
      if (snapshot.status !== 'running') throw new Error(snapshot.error ?? `${label} 未运行`);
    }, `${label} 已运行；控台通信另外检查`, (profile[id]?.startupTimeoutMs ?? 30_000) + stepDeadlineMs);
    return result !== null;
  };
  if (await start('ma2')) await connect();
  // MA 3D also opens native remote ports; establish onPC channels first.
  await start('ma3d');
}

/** Steps run one at a time in a fixed order with one explicit attempt each.
 * The first failure stops the run; every later step reports it was not run. */
export async function connectDevices(options: DeviceConnectionOptions): Promise<void> {
  const checks = useConnectionCheckStore.getState();
  if (!checks.begin(tasks)) return;
  const issues: string[] = [];
  let stoppedBy: string | null = null;
  const skip = (id: string, detail: string): void => stoppedBy ? checks.finish(id, 'blocked', `没有执行，因为“${stoppedBy}”没通过`) : checks.finish(id, 'skipped', detail);
  const run = async <T>(id: string, label: string, operation: () => Promise<T>, detail: string | ((value: T) => string) = '检查通过', deadlineMs = stepDeadlineMs): Promise<{ value: T } | null> => {
    if (stoppedBy) { skip(id, ''); return null; }
    checks.checking(id);
    try {
      const value = await withDeadline(operation(), deadlineMs, label); checks.finish(id, 'ready', typeof detail === 'string' ? detail : detail(value)); return { value };
    } catch (error) {
      const raw = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
      const technicalError = options.password ? raw.replaceAll(options.password, '[REDACTED]') : raw;
      const message = `${label}：${toUserErrorMessage(technicalError)}`;
      checks.finish(id, 'error', message); issues.push(message); options.onIssues([...issues]);
      stoppedBy = label;
      await desktop.recordLog({ level: 'warning', category: 'device', message, result: 'failed', details: { step: id, technicalError } }).catch(console.error);
      return null;
    }
  };
  let profile = options.draft;
  const detectedMaPrograms: Partial<Record<'ma2' | 'ma3d', string>> = {};
  const internal = options.project?.playbackSource === 'internal';
  const connectMa2 = async (): Promise<void> => {
    const method = readMa2Method();
    if (method === 'midi') { skip('ma2', '没有启用网络连接，当前用 MIDI'); skip('bridge', '仅 MIDI 时不需要读写控台'); return; }
    if (method === 'local') {
      skip('ma2', '当前使用本机 onPC');
      await run('bridge', 'MA2 工程通信', async () => connectLocalMa2((await desktop.getMa2DataDirectory()) ?? ''), '本机控台通信正常'); return;
    }
    let moved = '';
    await run('ma2', 'MA2 网络', async () => {
      const status = ma2NetworkStatusSchema.parse(await connectDiscoveredMa2(undefined, undefined, notice => { moved = notice; }));
      if (status.state !== 'connected') throw new Error(status.error ?? '控台没有登录成功');
      // The connection this result stands on, as main just read it back (check-basis.ts).
      useMa2NetworkStatusStore.setState({ status, error: null });
      return status;
    }, status => moved || `控台 ${status.settings?.host ?? ''} 登录成功`, ma2StepDeadlineMs);
    // 2026-11-09: a check refused during a show stayed as 读写异常 for good; it is only not run yet. 2026-11-10 第 3 题: it
    // waits only while the program moves; paused, paused at the end or P1 waiting for the next song, it checks.
    const show = currentShowGate('connections.check');
    if (!stoppedBy && show.kind === 'wait') { checks.waitForShow('bridge', show.message); return; }
    await run('bridge', 'MA2 工程通信', async () => { await checkNetworkMa2(); return projectMa2ShowNote(options.project); }, note => note ? `控台读写通信正常。${note}` : '控台读写通信正常');
  };
  try {
    const detection = await run('discovery', '程序识别', () => desktop.detectLocalIntegrations());
    if (detection) {
      options.onDetection(detection.value);
      const { obs, p1 } = detection.value.applications;
      profile = { ...profile,
        obs: obs.executablePath && obs.workingDirectory ? { ...profile.obs, executablePath: obs.executablePath, workingDirectory: obs.workingDirectory } : profile.obs,
        p1: p1.executablePath && p1.workingDirectory ? { ...profile.p1, executablePath: p1.executablePath, workingDirectory: p1.workingDirectory } : profile.p1
      };
      // Detection reports MA programs only; registering one to start is the operator's choice.
      for (const id of ['ma2', 'ma3d'] as const) {
        const path = detection.value.applications[id]?.executablePath;
        if (path) detectedMaPrograms[id] = path;
      }
    }
    const loop = await run('loop', '虚拟 MIDI', async () => {
      let status = loopMidiStatusSchema.parse(await desktop.loopMidi('detect'));
      if (status.state === 'missing' && !profile.loopMidi?.autoStart) return false;
      // Automatic startup preference does not disable an explicit Connect All action.
      if (status.state !== 'running') status = loopMidiStatusSchema.parse(await desktop.loopMidi('start'));
      if (status.state !== 'running') throw new Error('loopMIDI 没有启动，请安装并设置虚拟端口');
      return true;
    }, 'loopMIDI 已运行，端口另外检查');
    if (loop?.value === false) skip('loop', '没有安装虚拟 MIDI；用实体 MIDI 接口不受影响');
    const midi = await run('midi', '系统 MIDI', options.readMidiPorts, '系统 MIDI 检测通过');
    const nativeMtc = usesNativeMidiOutput(options.project, 'output');
    const nativeDevices = useIntegrationStore.getState().nativeDevices;
    if (nativeMtc && nativeDevices) {
      profile = applyDetectedLightingMidiPorts(profile, nativeDevices.midiOutputs.map(port => ({ id: String(port.id), name: port.name,
        manufacturer: '', direction: 'output', state: 'connected', connection: 'closed' })), true).profile;
    }
    if (midi) {
      if (!nativeMtc) profile = applyDetectedLightingMidiPorts(profile, midi.value, internal).profile;
      if (options.project && !internal) profile = applyDetectedP1MidiPorts(profile, midi.value).profile;
    }
    profile = { ...profile, updatedAt: new Date().toISOString() };
    await run('profile', '连接配置', async () => {
      const address = obsWebSocketUrlSchema.safeParse(profile.obs.webSocketUrl);
      if (!address.success && profile.obs.connectionMethod === 'manual') throw new Error(address.error.issues.map(issue => issue.message).join('；'));
      profile = { ...profile, obs: { ...profile.obs, webSocketUrl: address.success ? address.data : 'ws://127.0.0.1:4455' } };
      await desktop.saveIntegrationProfile({ profile, ...(options.password ? { obsPassword: options.password } : {}) });
      useIntegrationStore.getState().setProfile(profile); options.onProfile(profile);
    });
    const obsTask = async (): Promise<void> => {
      await run('obs', 'OBS 控制', async () => {
        if (useIntegrationStore.getState().obs.status !== 'connected') {
          let snapshot;
          if (profile.obs.connectionMethod !== 'manual') {
            const local = localObsConnectionResultSchema.parse(await desktop.connectLocalObs());
            snapshot = local.snapshot;
            const savedProfile = await desktop.loadIntegrationProfile();
            if (savedProfile) { profile = savedProfile; useIntegrationStore.getState().setProfile(profile); options.onProfile(profile); }
            options.onObsPassword?.(local.password);
          } else {
            const hostname = new URL(profile.obs.webSocketUrl).hostname;
            if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) useIntegrationStore.getState().setProcess(await desktop.startExternalApplication('obs'));
            snapshot = await desktop.connectObs();
          }
          useIntegrationStore.getState().setObs(snapshot);
          if (snapshot.status !== 'connected') throw new Error(snapshot.error ?? 'OBS 没有连上');
        }
      }, 'OBS 控制已连接');
      await run('obs-inventory', 'OBS 场景清单', async () => {
        useIntegrationStore.getState().setInventory(await desktop.readObsInventory());
      }, 'OBS 场景清单已读取');
      await run('preview', 'OBS 预览', async () => {
        const preview = obsPreviewSession.open();
        try { await preview.next(); }
        finally { await preview.close(); }
      }, '已收到 OBS 预览画面');
    };
    const p1Task = async (): Promise<void> => {
      if (internal || !options.project) { skip('p1', internal ? '当前由联动台播放，不需要启动 P1' : '还没选择要跟随的 P1 工程'); return; }
      await run('p1', 'P1 播放器', async () => {
        const snapshot = await desktop.startExternalApplication('p1'); useIntegrationStore.getState().setProcess(snapshot);
        if (snapshot.status !== 'running') throw new Error(snapshot.error ?? 'P1 没有运行');
        if (midi) await options.listenToP1();
        else throw new Error('P1 已启动，但系统 MIDI 没有准备好，还收不到时间码');
      }, 'P1 已运行，可以接收时间码；等待 P1 开始播放');
    };
    const portsTask = async (): Promise<void> => {
      const checkedNativeOutputs = new Map<string, Promise<void>>();
      for (const target of midiConnectionTargets(profile, options.project)) {
        const key = `port:${target.id}`;
        checks.checking(key);
        if (!target.required) { skip(key, '未启用此接口'); continue; }
        const mapped = profile.midiPortProfiles.find(port => port.id === target.id && port.direction === target.direction);
        // P1's timecode input is the main process's (0.5.9 P4, p1-follow-host.ts): only checked here, opened by the P1 step.
        const nativeOutput = usesNativeMidiOutput(options.project, target.direction), p1Input = target.direction === 'input' && target.id === profile.p1.mtcInputPortProfileId;
        await run(key, target.name, async () => {
          if (!mapped?.portName) throw new Error('还没设置接口，请在“音频与 MIDI”里选择');
          if (nativeOutput) {
            if (!nativeDevices) throw new Error(useIntegrationStore.getState().nativeDeviceError ?? '还没检测 Windows 设备，请刷新端口');
            if (nativeDevices.midiOutputs.filter(port => port.name === mapped.portName).length !== 1) throw new Error(`找不到 Windows MIDI 接口，或有重名接口：${mapped.portName}`);
            if (!checkedNativeOutputs.has(mapped.portName)) {
              checkedNativeOutputs.set(mapped.portName, desktop.checkNativeMidiOutput({ version: 1, portName: mapped.portName }));
            }
            await checkedNativeOutputs.get(mapped.portName);
            return;
          }
          if (!midi) throw new Error('系统 MIDI 没有准备好，请先处理系统检测里的问题');
          const matching = midi.value.filter(port => port.name === mapped.portName && port.direction === target.direction && port.state === 'connected');
          if (matching.length !== 1) throw new Error('接口不可用或有重名接口，请检查设备连接');
          if (p1Input) return;
          const errors = await options.openMidiPorts([target.id], target.direction);
          if (errors.length) throw new Error(errors.join('；'));
        }, nativeOutput ? 'Windows 接口检查通过；现在不发送时间码，播放时才打开接口发送' : p1Input ? '接口可用；跟随 P1 时由联动台在后台接收时间码' : '接口已打开；还没发送任何 Cue 或时间码');
      }
    };
    await obsTask();
    await run('audio', '音频输出', async () => {
      await assertAudioOutputAvailable(profile.internalPlayer);
    }, '播放设备可用，播放时开始输出声音');
    await portsTask();
    await p1Task();
    await startMaPrograms(profile, detectedMaPrograms, run, skip, connectMa2);
  } finally {
    for (const id of useConnectionCheckStore.getState().pending) skip(id, '未执行');
    checks.end(); options.onIssues([...issues]);
  }
}
