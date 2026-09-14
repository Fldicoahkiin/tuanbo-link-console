import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ScanSearch } from 'lucide-react';
import { checkNetworkMa2, connectLocalMa2 } from '../stores/ma2-connection-store';
import { ma2NetworkStatusSchema } from '@tb/schema';
import type { IntegrationProfile } from '@tb/schema';
import type { LinkLocalIntegrationDetection } from '@tb/core/link';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';
import { useIntegrationStore } from '../stores/integration-store';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { applyDetectedP1MidiPorts } from '../view-models/local-integration-midi';
import { prepareLoopMidi } from '../view-models/loop-midi';

type LocalConnectionOptions = {
  draft: IntegrationProfile;
  password: string;
  storedProfile: IntegrationProfile | null;
  readMidiPorts: () => Promise<readonly MidiPortSnapshot[]>;
  notify: (message: string, tone?: 'info' | 'error') => void;
  onDraft: (profile: IntegrationProfile) => void;
  onPasswordCleared: () => void;
  onBusyChange: (busy: boolean) => void;
};

export function useLocalIntegrationConnection(options: LocalConnectionOptions): {
  detection: LinkLocalIntegrationDetection | null;
  issues: string[];
  connect: () => void;
} {
  const connecting = useRef(false);
  const [detection, setDetection] = useState<LinkLocalIntegrationDetection | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const connect = (): void => {
    if (connecting.current) return;
    connecting.current = true;
    options.onBusyChange(true);
    void runLocalIntegrationConnection(options, setDetection, setIssues)
      .catch((error: unknown) => options.notify(error instanceof Error ? error.message : String(error), 'error'))
      .finally(() => { connecting.current = false; options.onBusyChange(false); });
  };
  return { detection, issues, connect };
}

async function runLocalIntegrationConnection(
  options: LocalConnectionOptions,
  onDetection: (detection: LinkLocalIntegrationDetection) => void,
  onIssues: (issues: string[]) => void
): Promise<void> {
  const result = await linkDesktopViewModel.detectLocalIntegrations();
  onDetection(result);
  let next = applyDetectedApplications(options.draft, result);
  const issues: string[] = [];
  const internal = useDocumentStore.getState().project?.playbackSource === 'internal';
  for (const id of internal ? ['obs'] as const : ['obs', 'p1'] as const) {
    if (!result.applications[id].executablePath) issues.push(`${applicationLabel(id)}：未找到可靠的可执行文件`);
  }
  try { await prepareLoopMidi(next); } catch (error) { issues.push(errorMessage(error)); }
  const ports = await options.readMidiPorts();
  if (!internal) {
    const midiResolution = applyDetectedP1MidiPorts(next, ports);
    next = midiResolution.profile; issues.push(...midiResolution.issues);
  }
  const storedCredential = options.storedProfile ? await linkDesktopViewModel.getSecurityPreflight() : null;
  if (options.password === '' && storedCredential?.credentialDecryptable !== true) {
    issues.push('OBS：WebSocket 已启用认证，请在下方填写密码');
  }
  options.onDraft(next);
  onIssues(issues);
  const profile = { ...next, updatedAt: new Date().toISOString() };
  await linkDesktopViewModel.saveIntegrationProfile({ profile, ...(options.password !== '' ? { obsPassword: options.password } : {}) });
  useIntegrationStore.getState().setProfile(profile);
  options.onDraft(profile);
  options.onPasswordCleared();
  await startAvailableApplication('obs', issues);
  if (options.password !== '' || storedCredential?.credentialDecryptable === true) {
    try {
      useIntegrationStore.getState().setObs(await linkDesktopViewModel.connectObs());
      useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
    } catch (error) {
      issues.push(`OBS WebSocket：${errorMessage(error)}`);
    }
  }
  if (!internal) await startAvailableApplication('p1', issues);
  try { await connectSavedMa2(); } catch (error) { issues.push(`MA2：${errorMessage(error)}`); }
  onIssues([...issues]);
  options.notify(issues.length === 0
    ? '设备连接检查已完成。'
    : `本机程序路径已保存并连接可用部分；仍有 ${String(issues.length)} 个阻断项需要处理。`, issues.length === 0 ? 'info' : 'error');
}

export function DetectionReport({ detection, issues }: { detection: LinkLocalIntegrationDetection; issues: readonly string[] }): JSX.Element {
  return <details className={`integration-detection ${issues.length > 0 ? 'has-issues' : 'ready'}`} open={issues.length > 0}>
    <summary className="panel-title"><span><ScanSearch />本机识别结果</span><small>{issues.length > 0 ? `${String(issues.length)} 项需要处理` : '全部正常'}</small><ChevronDown /></summary>
    <div className="detection-applications">{(['obs', 'p1'] as const).map((id) => {
      const application = detection.applications[id];
      return <div key={id}><CheckCircle2 /><span><strong>{applicationLabel(id)}</strong><small>{application.executablePath ?? '未找到'} · {application.version ?? '版本未知'} · {application.running ? '正在运行' : '已安装'}</small></span></div>;
    })}</div>
    {issues.length > 0 ? <div className="detection-issues">{issues.map((issue) => <p key={issue}><AlertTriangle />{issue}</p>)}</div> : null}
  </details>;
}

function applyDetectedApplications(profile: IntegrationProfile, detection: LinkLocalIntegrationDetection): IntegrationProfile {
  const obs = detection.applications.obs;
  const p1 = detection.applications.p1;
  return {
    ...profile,
    obs: obs.executablePath && obs.workingDirectory ? { ...profile.obs, executablePath: obs.executablePath, workingDirectory: obs.workingDirectory } : profile.obs,
    p1: p1.executablePath && p1.workingDirectory ? { ...profile.p1, executablePath: p1.executablePath, workingDirectory: p1.workingDirectory } : profile.p1,
    acceptedVersions: {
      obs: obs.version ?? profile.acceptedVersions.obs,
      p1: p1.version ?? profile.acceptedVersions.p1
    }
  };
}

async function startAvailableApplication(id: 'obs' | 'p1', issues: string[]): Promise<void> {
  try {
    useIntegrationStore.getState().setProcess(await linkDesktopViewModel.startExternalApplication(id));
  } catch (error) {
    issues.push(`${applicationLabel(id)}：${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applicationLabel(id: 'obs' | 'p1'): string {
  if (id === 'obs') return 'OBS Studio';
  return 'HiRender P1';
}

async function connectSavedMa2(): Promise<void> {
  const directory = localStorage.getItem('tblink.ma2-onpc-data-directory.v1') ?? '';
  const method = localStorage.getItem('tblink.ma2-connection-method.v1') ?? (directory ? 'local' : 'network');
  if (method === 'local') { await connectLocalMa2(directory); return; }
  let status = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
  if (!status.settings) throw new Error('尚未选择控台，请先在设备连接中保存目标');
  if (status.state !== 'connected') status = ma2NetworkStatusSchema.parse(await window.tbLink.connectMa2Network());
  if (status.state !== 'connected') throw new Error(status.error ?? '控台登录未完成');
  try { await checkNetworkMa2(); } catch (error) { throw new Error(`控台已登录，但插件未就绪：${errorMessage(error)}`); }
}
