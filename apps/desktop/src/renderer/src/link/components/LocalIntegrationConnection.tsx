import { Fragment, useRef, useState } from 'react';
import { Disclosure, Notice } from '../ui';
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
  onObsPassword?: (password: string) => void;
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
  return <Disclosure title="本机识别结果" description={issues.length > 0 ? `${String(issues.length)} 项要处理` : '全部正常'} open={issues.length > 0}>
    {issues.length > 0 ? <Notice tone="warning"><ul className="settings-list">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></Notice> : null}
    <dl className="settings-facts">{(['obs', 'p1', 'ma2', 'ma3d'] as const).map((id) => {
      const application = detection.applications[id];
      if (!application) return null;
      return <Fragment key={id}><dt>{applicationLabel(id)}</dt><dd>{application.running ? '正在运行' : application.executablePath ? '已安装，未运行' : '没找到安装位置'} · {application.version ?? '版本未知'}{application.executablePath ? <><br /><span className="settings-connection-address">{application.executablePath}</span></> : null}</dd></Fragment>;
    })}</dl>
    <ul className="settings-list" aria-label="检测到的 MIDI 设备">{ports.filter(port => port.state === 'connected').map(port => <li key={`${port.direction}:${port.id}`}><strong>{port.name}</strong>：{port.direction === 'input' ? 'MIDI 输入' : 'MIDI 输出'} · {port.manufacturer || '厂商没提供'}</li>)}</ul>
  </Disclosure>;
}

function applicationLabel(id: 'obs' | 'p1' | 'ma2' | 'ma3d'): string {
  return { obs: 'OBS Studio', p1: 'HiRender P1', ma2: 'MA2 onPC', ma3d: 'MA 3D' }[id];
}
