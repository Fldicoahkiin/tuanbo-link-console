import { toUserErrorMessage, type LinkLocalIntegrationDetection } from '@tb/core/link';
import { loopMidiStatusSchema, ma2NetworkStatusSchema, type IntegrationProfile, type LinkProject } from '@tb/schema';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';
import { useIntegrationStore } from '../stores/integration-store';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { checkNetworkMa2, connectDiscoveredMa2, connectLocalMa2 } from '../stores/ma2-connection-store';
import { readMa2Method } from '../stores/ma2-mode-store';
import { linkDesktopViewModel as desktop } from './link-desktop-view-model';
import { applyDetectedLightingMidiPorts, applyDetectedP1MidiPorts } from './local-integration-midi';
import { midiConnectionTargets } from './connection-targets';
import { obsPreviewSession } from './obs-preview-session';

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
};
const tasks = ['discovery', 'profile', 'loop', 'midi', 'obs', 'preview', 'audio', 'p1', 'ma2', 'bridge'];

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
      const message = `${label}：${toUserErrorMessage(error)}`;
      checks.finish(id, 'error', message); issues.push(message); options.onIssues([...issues]);
      await desktop.recordLog({ level: 'warning', category: 'device', message, result: 'failed' }).catch(console.error);
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
      let status = ma2NetworkStatusSchema.parse(await desktop.getMa2NetworkStatus());
      if (status.state !== 'connected') status = status.settings ? ma2NetworkStatusSchema.parse(await desktop.connectMa2Network()) : await connectDiscoveredMa2();
      if (status.state !== 'connected') throw new Error(status.error ?? '控台登录未完成');
    }, '控台网络登录成功');
    if (connected) await run('bridge', 'MA2 工程通信', checkNetworkMa2, '控台工程通信已响应');
    else skip('bridge', '等待控台网络连接成功');
  };
  try {
    // MA2 uses its own saved settings and remains independent of machine/MIDI discovery.
    const ma2Task = connectMa2();
    const detection = await run('discovery', '程序识别', () => desktop.detectLocalIntegrations());
    if (detection) {
      options.onDetection(detection.value);
      const { obs, p1 } = detection.value.applications;
      profile = { ...profile,
        obs: obs.executablePath && obs.workingDirectory ? { ...profile.obs, executablePath: obs.executablePath, workingDirectory: obs.workingDirectory } : profile.obs,
        p1: p1.executablePath && p1.workingDirectory ? { ...profile.p1, executablePath: p1.executablePath, workingDirectory: p1.workingDirectory } : profile.p1
      };
    }
    const audioTask = run('audio', '音频输出', async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const id = profile.internalPlayer?.audioOutputDeviceId ?? 'default';
      if (!devices.some(device => device.kind === 'audiooutput' && device.deviceId === id)) throw new Error('所选播放设备不可用，请在音频设置中重新选择输出线路');
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
    if (midi) {
      profile = applyDetectedLightingMidiPorts(profile, midi.value, internal).profile;
      if (options.project && !internal) profile = applyDetectedP1MidiPorts(profile, midi.value).profile;
    }
    profile = { ...profile, updatedAt: new Date().toISOString() };
    const saved = await run('profile', '连接配置', async () => {
      await desktop.saveIntegrationProfile({ profile, ...(options.password ? { obsPassword: options.password } : {}) });
      useIntegrationStore.getState().setProfile(profile); options.onProfile(profile);
    });
    const obsTask = async (): Promise<void> => {
      if (!saved) { skip('obs', '连接配置未保存'); skip('preview', '等待 OBS 连接'); return; }
      const connected = await run('obs', 'OBS 控制', async () => {
        if (useIntegrationStore.getState().obs.status !== 'connected') {
          const hostname = new URL(profile.obs.webSocketUrl).hostname;
          if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) useIntegrationStore.getState().setProcess(await desktop.startExternalApplication('obs'));
          const snapshot = await desktop.connectObs(); useIntegrationStore.getState().setObs(snapshot);
          if (snapshot.status !== 'connected') throw new Error(snapshot.error ?? 'OBS 连接未完成');
        }
        useIntegrationStore.getState().setInventory(await desktop.readObsInventory());
      }, 'OBS 控制已连接，场景清单已读取');
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
      for (const target of midiConnectionTargets(profile, options.project)) {
        const key = `port:${target.id}`;
        checks.checking(key);
        if (!target.required) { skip(key, '未启用此接口'); continue; }
        await run(key, target.name, async () => {
          if (!saved) throw new Error('连接配置未保存');
          if (!midi) throw new Error('系统 MIDI 未就绪，请处理系统检测项');
          const mapped = profile.midiPortProfiles.find(port => port.id === target.id && port.direction === target.direction);
          if (!mapped?.portName) throw new Error('尚未配置接口，请在音频与 MIDI 中选择');
          const matching = midi.value.filter(port => port.name === mapped.portName && port.direction === target.direction && port.state === 'connected');
          if (matching.length !== 1) throw new Error('接口不可用或名称重复，请检查设备连接');
          const errors = await options.openMidiPorts([target.id], target.direction);
          if (errors.length) throw new Error(errors.join('；'));
        }, '接口已打开；未发送任何 Cue 或时间码');
      }
    };
    await Promise.all([obsTask(), p1Task(), portsTask(), ma2Task, audioTask]);
  } finally { checks.end(); options.onIssues([...issues]); }
}
