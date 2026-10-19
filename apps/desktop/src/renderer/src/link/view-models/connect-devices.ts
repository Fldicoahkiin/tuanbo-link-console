import { toUserErrorMessage, type LinkLocalIntegrationDetection } from '@tb/core/link';
import { loopMidiStatusSchema, ma2NetworkStatusSchema, obsWebSocketUrlSchema, localObsConnectionResultSchema, type IntegrationProfile, type LinkProject } from '@tb/schema';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';
import { useIntegrationStore } from '../stores/integration-store';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { checkNetworkMa2, connectDiscoveredMa2, connectLocalMa2 } from '../stores/ma2-connection-store';
import { readMa2Method } from '../stores/ma2-mode-store';
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
const tasks = ['discovery', 'profile', 'loop', 'midi', 'obs', 'preview', 'audio', 'p1', 'ma2-app', 'ma3d', 'ma2', 'bridge'];
type ConnectionStep = <T>(id: string, label: string, operation: () => Promise<T>, detail?: string) => Promise<{ value: T } | null>;

async function startMaPrograms(profile: IntegrationProfile, saved: boolean, run: ConnectionStep, skip: (id: string, detail: string) => void, connect: () => Promise<void>): Promise<void> {
  const start = async (id: 'ma2' | 'ma3d'): Promise<boolean> => {
    const key = id === 'ma2' ? 'ma2-app' : 'ma3d';
    const label = id === 'ma2' ? 'MA2 onPC' : 'MA 3D';
    if (!profile[id]?.connectOnDemand) { skip(key, profile[id] ? '已关闭一键启动' : '未配置本机程序；可在 MA2 设置选择程序'); return true; }
    const result = await run(key, label, async () => {
      if (!saved) throw new Error('启动路径未保存，无法启动程序');
      const snapshot = await desktop.startExternalApplication(id);
      useIntegrationStore.getState().setProcess(snapshot);
      if (snapshot.status !== 'running') throw new Error(snapshot.error ?? `${label} 未运行`);
    }, `${label} 已运行；控台通信另行检查`);
    return result !== null;
  };
  await start('ma2');
  // An external console does not depend on local onPC startup. Local connections
  // still validate the selected process before sending credentials or commands.
  await connect();
  // MA 3D also opens native remote ports; establish onPC channels first.
  await start('ma3d');
}

/** One explicit attempt per task. A failed dependency cannot stop unrelated connections. */
export async function connectDevices(options: DeviceConnectionOptions): Promise<void> {
  const checks = useConnectionCheckStore.getState();
  if (!checks.begin(tasks)) return;
  const issues: string[] = [];
  const skip = (id: string, detail: string): void => checks.finish(id, 'skipped', detail);
  const run = async <T>(id: string, label: string, operation: () => Promise<T>, detail = '检查通过'): Promise<{ value: T } | null> => {
    checks.checking(id);
    try {
      const value = await operation(); checks.finish(id, 'ready', detail); return { value };
    } catch (error) {
      const raw = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
      const technicalError = options.password ? raw.replaceAll(options.password, '[REDACTED]') : raw;
      const explanation = toUserErrorMessage(technicalError);
      const reason = explanation.startsWith('操作未能完成。') ? `操作失败：${technicalError.split('\n')[0]?.slice(0, 300) || '未返回错误内容'}` : explanation;
      const message = `${label}：${reason}`;
      checks.finish(id, 'error', message); issues.push(message); options.onIssues([...issues]);
      await desktop.recordLog({ level: 'warning', category: 'device', message, result: 'failed', details: { step: id, technicalError } }).catch(console.error);
      return null;
    }
  };
  let profile = options.draft;
  const internal = options.project?.playbackSource === 'internal';
  const connectMa2 = async (): Promise<void> => {
    const method = readMa2Method();
    if (method === 'midi') { skip('ma2', '未启用网络连接，当前使用 MIDI'); skip('bridge', 'MIDI 模式无需工程通信'); return; }
    if (method === 'local') {
      skip('ma2', '当前使用本机 onPC');
      await run('bridge', 'MA2 工程通信', () => connectLocalMa2(localStorage.getItem('tblink.ma2-onpc-data-directory.v1') ?? ''), '本机控台通信已响应'); return;
    }
    const connected = await run('ma2', 'MA2 网络', async () => {
      const status = ma2NetworkStatusSchema.parse(await connectDiscoveredMa2());
      if (status.state !== 'connected') throw new Error(status.error ?? '控台登录未完成');
    }, '控台网络登录成功');
    if (connected) await run('bridge', 'MA2 工程通信', checkNetworkMa2, '控台工程通信已响应');
    else skip('bridge', '等待控台网络连接成功');
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
      for (const id of ['ma2', 'ma3d'] as const) {
        const application = detection.value.applications[id];
        if (!profile[id] && application?.executablePath && application.workingDirectory) {
          profile = { ...profile, [id]: { executablePath: application.executablePath, workingDirectory: application.workingDirectory,
            arguments: [], startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000, connectOnDemand: true } };
        }
      }
    }
    const audioTask = run('audio', '音频输出', async () => {
      await assertAudioOutputAvailable(profile.internalPlayer);
    }, '播放设备可用，正式音频在播放时启用');
    const loop = await run('loop', '虚拟 MIDI', async () => {
      let status = loopMidiStatusSchema.parse(await desktop.loopMidi('detect'));
      if (status.state === 'missing' && !profile.loopMidi?.autoStart) return false;
      // Automatic startup preference does not disable an explicit Connect All action.
      if (status.state !== 'running') status = loopMidiStatusSchema.parse(await desktop.loopMidi('start'));
      if (status.state !== 'running') throw new Error('loopMIDI 未启动，请安装并配置虚拟端口');
      return true;
    }, 'loopMIDI 已运行，端口单独检查');
    if (loop?.value === false) skip('loop', '未安装虚拟 MIDI，实体 MIDI 不依赖此项');
    const midi = await run('midi', '系统 MIDI', options.readMidiPorts, '系统 MIDI 检测通过');
    const nativeMtc = usesNativeMidiOutput(profile, options.project, 'output');
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
    const saved = await run('profile', '连接配置', async () => {
      const address = obsWebSocketUrlSchema.safeParse(profile.obs.webSocketUrl);
      if (!address.success && profile.obs.connectionMethod === 'manual') throw new Error(address.error.issues.map(issue => issue.message).join('；'));
      profile = { ...profile, obs: { ...profile.obs, webSocketUrl: address.success ? address.data : 'ws://127.0.0.1:4455' } };
      await desktop.saveIntegrationProfile({ profile, ...(options.password ? { obsPassword: options.password } : {}) });
      useIntegrationStore.getState().setProfile(profile); options.onProfile(profile);
    });
    const ma2Task = startMaPrograms(profile, Boolean(saved), run, skip, connectMa2);
    const obsTask = async (): Promise<void> => {
      if (!saved) { skip('obs', '连接配置未保存'); skip('preview', '等待 OBS 连接'); return; }
      const connected = await run('obs', 'OBS 控制', async () => {
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
          if (snapshot.status !== 'connected') throw new Error(snapshot.error ?? 'OBS 连接未完成');
        }
      }, 'OBS 控制已连接');
      if (connected) await run('obs-inventory', 'OBS 场景清单', async () => {
        useIntegrationStore.getState().setInventory(await desktop.readObsInventory());
      }, 'OBS 场景清单已读取');
      if (connected) await run('preview', 'OBS 预览', async () => {
        const preview = obsPreviewSession.open();
        try { await preview.next(); }
        finally { await preview.close(); }
      }, '已收到真实预览画面');
      else skip('preview', '等待 OBS 控制连接成功');
    };
    const p1Task = async (): Promise<void> => {
      if (internal || !options.project) { skip('p1', internal ? '本机播放模式无需启动 P1' : '未选择 P1 跟随工程'); return; }
      if (!saved) { skip('p1', '连接配置未保存'); return; }
      await run('p1', 'P1 播放器', async () => {
        const snapshot = await desktop.startExternalApplication('p1'); useIntegrationStore.getState().setProcess(snapshot);
        if (snapshot.status !== 'running') throw new Error(snapshot.error ?? 'P1 尚未运行');
        if (midi) await options.listenToP1();
        else throw new Error('程序已启动，系统 MIDI 未就绪，时间码监听尚未连接');
      }, 'P1 已运行，时间码监听已连接；等待真实播放信号');
    };
    const portsTask = async (): Promise<void> => {
      const checkedNativeOutputs = new Map<string, Promise<void>>();
      for (const target of midiConnectionTargets(profile, options.project)) {
        const key = `port:${target.id}`;
        checks.checking(key);
        if (!target.required) { skip(key, '未启用此接口'); continue; }
        const mapped = profile.midiPortProfiles.find(port => port.id === target.id && port.direction === target.direction);
        const nativeOutput = usesNativeMidiOutput(profile, options.project, target.direction);
        await run(key, target.name, async () => {
          if (!saved) throw new Error('连接配置未保存');
          if (!mapped?.portName) throw new Error('尚未配置接口，请在音频与 MIDI 中选择');
          if (nativeOutput) {
            if (!nativeDevices) throw new Error(useIntegrationStore.getState().nativeDeviceError ?? 'Windows 原生设备尚未检测，请刷新端口');
            if (nativeDevices.midiOutputs.filter(port => port.name === mapped.portName).length !== 1) throw new Error(`Windows MIDI 接口未检测到或名称重复：${mapped.portName}`);
            if (!checkedNativeOutputs.has(mapped.portName)) {
              checkedNativeOutputs.set(mapped.portName, desktop.checkNativeMidiOutput({ version: 1, portName: mapped.portName }));
            }
            await checkedNativeOutputs.get(mapped.portName);
            return;
          }
          if (!midi) throw new Error('系统 MIDI 未就绪，请处理系统检测项');
          const matching = midi.value.filter(port => port.name === mapped.portName && port.direction === target.direction && port.state === 'connected');
          if (matching.length !== 1) throw new Error('接口不可用或名称重复，请检查设备连接');
          const errors = await options.openMidiPorts([target.id], target.direction);
          if (errors.length) throw new Error(errors.join('；'));
        }, nativeOutput ? 'Windows 接口打开检查通过；未发送时间码，播放时打开并输出' : '接口已打开；未发送任何 Cue 或时间码');
      }
    };
    await Promise.all([obsTask(), p1Task(), portsTask(), ma2Task, audioTask]);
  } finally { checks.end(); options.onIssues([...issues]); }
}
