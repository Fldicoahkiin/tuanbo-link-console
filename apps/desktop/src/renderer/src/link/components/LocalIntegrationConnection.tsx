import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ScanSearch } from 'lucide-react';
import type { IntegrationProfile } from '@tb/schema';
import { toUserErrorMessage, type LinkLocalIntegrationDetection } from '@tb/core/link';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';
import { useIntegrationStore } from '../stores/integration-store';
import { useDocumentStore } from '../stores/document-store';
import { connectDevices } from '../view-models/connect-devices';

type LocalConnectionOptions = {
  draft: IntegrationProfile;
  password: string;
  readMidiPorts: () => Promise<readonly MidiPortSnapshot[]>;
  openMidiPorts: (ids: readonly string[], direction: 'input' | 'output') => Promise<string[]>;
  listenToP1: () => Promise<void>;
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
    connecting.current = true; setIssues([]); options.onBusyChange(true);
    void connectDevices({ ...options, project: useDocumentStore.getState().project,
      onDetection: setDetection, onIssues: setIssues,
      onProfile: profile => { options.onDraft(profile); options.onPasswordCleared(); }
    }).catch((error: unknown) => { const message = toUserErrorMessage(error); setIssues(previous => [...previous, message]); options.notify(message, 'error'); })
      .finally(() => { connecting.current = false; options.onBusyChange(false); });
  };
  return { detection, issues, connect };
}

export function DetectionReport({ detection, issues }: { detection: LinkLocalIntegrationDetection; issues: readonly string[] }): JSX.Element {
  const ports = useIntegrationStore(state => state.midiPorts);
  return <details className={`integration-detection ${issues.length > 0 ? 'has-issues' : 'ready'}`} open={issues.length > 0}>
    <summary className="panel-title"><span><ScanSearch />本机识别结果</span><small>{issues.length > 0 ? `${String(issues.length)} 项需要处理` : '全部正常'}</small><ChevronDown /></summary>
    <div className="detection-applications">{(['obs', 'p1'] as const).map((id) => {
      const application = detection.applications[id];
      return <div key={id}>{application.executablePath ? <CheckCircle2 /> : <AlertTriangle />}<span><strong>{applicationLabel(id)}</strong><small>{application.executablePath ?? '未找到'} · {application.version ?? '版本未知'} · {application.running ? '正在运行' : application.executablePath ? '已安装，未运行' : '未检测到安装位置'}</small></span></div>;
    })}</div>
    <div className="detection-applications" aria-label="检测到的 MIDI 设备">{ports.filter(port => port.state === 'connected').map(port => <div key={`${port.direction}:${port.id}`}><CheckCircle2 /><span><strong>{port.name}</strong><small>{port.direction === 'input' ? 'MIDI 输入' : 'MIDI 输出'} · {port.manufacturer || '厂商未提供'}</small></span></div>)}</div>
    {issues.length > 0 ? <div className="detection-issues">{issues.map((issue) => <p key={issue}><AlertTriangle />{issue}</p>)}</div> : null}
  </details>;
}

function applicationLabel(id: 'obs' | 'p1'): string {
  return id === 'obs' ? 'OBS Studio' : 'HiRender P1';
}
