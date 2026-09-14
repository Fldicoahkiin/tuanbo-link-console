import { useLocalMa2Store } from '../stores/ma2-connection-store';
import { useEffect, useState } from 'react';
import { ma2NetworkStatusSchema, type Ma2NetworkStatus } from '@tb/schema';
import { useIntegrationStore } from '../stores/integration-store';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { hasConnectedProfilePort } from '../../registry/link-midi-adapter';

export function ToolbarConnections(): JSX.Element {
  const projectName = useDocumentStore((state) => state.project?.name);
  const projectPath = useDocumentStore((state) => state.path);
  const dirty = useDocumentStore((state) => state.dirty);
  const obs = useIntegrationStore((state) => state.obs);
  const p1 = useIntegrationStore((state) => state.processes.p1);
  const profile = useIntegrationStore((state) => state.profile);
  const ports = useIntegrationStore((state) => state.midiPorts);
  const initialized = useIntegrationStore((state) => state.initialized);
  const internal = useDocumentStore((state) => state.project?.playbackSource === 'internal');
  const lastMtcAt = useRuntimeStore((state) => state.lastMtcAt);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (internal) return;
    const timer = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(timer);
  }, [internal]);
  const ids = internal ? [profile?.internalPlayer?.mtcOutputPortProfileId, profile?.internalPlayer?.controlInputPortProfileId] : [profile?.p1.mtcInputPortProfileId, profile?.p1.controlOutputPortProfileId];
  const configured = profile?.midiPortProfiles.filter((port) => ids.includes(port.id) && port.portName) ?? [];
  const connected = configured.filter((port) => profile && hasConnectedProfilePort(profile, port.id, ports)).length;
  const receiving = lastMtcAt !== null && now >= lastMtcAt && now - lastMtcAt <= 500;
  return <div className="toolbar-project-summary">
    {projectName ? <div className="toolbar-project-name" aria-label="当前工程" title={`${projectName}${projectPath ? `\n${projectPath}` : ''}`}><strong>{projectName}</strong>{dirty ? <span aria-label="未保存修改" title="未保存修改">·</span> : null}</div> : null}
    <div className="toolbar-connections" aria-label="连接状态">
    <Connection name="OBS" value={obs.status === 'connected' ? '已连接' : obs.status === 'connecting' || obs.status === 'reconnecting' ? '连接中' : obs.status === 'error' ? '异常' : '未连接'} ok={obs.status === 'connected'} detail={obs.error ?? undefined} />
    {internal ? <Connection name="主控" value={initialized ? '本机播放' : '初始化中'} ok={initialized} /> : <Connection name="P1" value={p1.status === 'running' ? '运行中' : p1.status === 'error' ? '异常' : '未运行'} ok={p1.status === 'running'} detail={p1.error ?? undefined} />}
    <Connection name="MIDI" value={!initialized ? '检测中' : !configured.length ? '未配置' : connected === configured.length ? '已连接' : '未连接'} ok={configured.length > 0 && connected === configured.length} detail={configured.map((port) => `${port.direction === 'input' ? '输入' : '输出'}：${port.portName} · ${profile && hasConnectedProfilePort(profile, port.id, ports) ? '已连接' : '未连接'}`).join('\n')} />
    <Ma2NetworkIndicator />
    {!internal ? <Connection name="MTC" value={receiving ? '接收中' : '无信号'} ok={receiving} /> : null}
  </div></div>;
}

function Ma2NetworkIndicator(): JSX.Element {
  const local = useLocalMa2Store();
  const [localMode, setLocalMode] = useState(false);
  const [status, setStatus] = useState<Ma2NetworkStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async (): Promise<void> => {
      try {
        const next = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
        if (!alive) return;
        const directory = localStorage.getItem('tblink.ma2-onpc-data-directory.v1');
        const method = localStorage.getItem('tblink.ma2-connection-method.v1');
        setLocalMode(method === 'local' || !method && Boolean(directory));
        setStatus(next); setError(null);
        timer = setTimeout(() => void update(), 1000);
      } catch (failure) { if (alive) { setStatus(null); setError(failure instanceof Error ? failure.message : String(failure)); } }
    };
    void update();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  if (localMode) return <Connection name="MA2" value={local.status === 'ready' ? '插件已响应' : local.status === 'connecting' ? '连接中' : local.status === 'error' ? '异常' : '未连接'} ok={local.status === 'ready'} detail={local.error ?? `本机 onPC：${local.directory}；MIDI 演出通道需单独验证`} />;
  const connected = status?.state === 'connected';
  return <Connection name="MA2" value={error || status?.error ? '异常' : connected ? '网络已连接' : status?.state === 'connecting' || status?.state === 'authenticating' ? '连接中' : status?.settings ? '未连接' : '网络未配置'} ok={connected} detail={error ?? status?.error ?? (connected ? `${status.settings?.host} · MA2 ${status.version}；网络登录已确认，插件与 MIDI 分别检查` : '在设置 → 设备连接中配置 MA2 网络连接')} />;
}

function Connection({ name, value, ok, detail }: { name: string; value: string; ok: boolean; detail?: string | undefined }): JSX.Element {
  return <span className={`toolbar-connection ${ok ? 'connected' : 'disconnected'}`} title={detail || `${name}：${value}`}><i aria-hidden="true" /><strong>{name}</strong><span>{value}</span></span>;
}
