import { Button, Card, Disclosure, Field, Notice, Select, StatusBadge } from '../ui';
import { setMa2Method, useMa2ModeStore } from '../stores/ma2-mode-store';
import { P1ProjectSyncPanel } from './P1ProjectSyncPanel';
import { Download } from 'lucide-react';
import { connectLocalMa2, useLocalMa2Store } from '../stores/ma2-connection-store';
import { SettingsSaves } from '../useSettingsExit';
import { useContext, useRef, useState } from 'react';
import { Ma2NetworkSettings, type Ma2NetworkView } from './Ma2NetworkSettings';
import { ma2EditingConnectionStatus } from '../view-models/connection-status';
import { useLiveConnectionChecks } from '../useStatusCenter';
import { Ma2CatalogSettings } from './Ma2CatalogSettings';
import { prepareMa2Editing } from '../runtime/ma2-editing-session';
import { useDocumentStore } from '../stores/document-store';
import { Ma2ProgramSettings } from './Ma2ProgramSettings';

export function Ma2ConnectionSettings({ disabled, notify, maintenanceHost, onMaintenance, onAudioSettings }: {
  disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void;
  onAudioSettings: () => void;
  maintenanceHost: HTMLDivElement | null; onMaintenance: () => void;
}): JSX.Element {
  const forms = useContext(SettingsSaves);
  const method = useMa2ModeStore((state) => state.method);
  const networkVisited = useRef(false);
  if (method === 'network') networkVisited.current = true;
  const setMethod = async (value: 'midi' | 'local' | 'network'): Promise<void> => {
    setBusy(true);
    try {
      const save = forms?.get('ma2');
      if (method === 'network' && save && !await save()) return;
      await setMa2Method(value);
    }
    catch (error) { notify(`切换连接方式失败：${String(error)}`, 'error'); }
    finally { setBusy(false); }
  };
  const [busy, setBusy] = useState(false);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [network, setNetwork] = useState<Ma2NetworkView | null>(null);
  const networkConnected = network?.state === 'connected';
  const bridge = useLiveConnectionChecks().bridge;
  const exportPlugin = async (): Promise<void> => {
    setBusy(true);
    try { const path = await window.tbLink.exportMa2Plugin(); if (path) notify(`插件与安装说明已导出：${path}`); }
    catch (error) { notify(`导出控台插件失败：${String(error)}`, 'error'); }
    finally { setBusy(false); }
  };
  const local = useLocalMa2Store();
  // The heading tells the same state, in the same colours, as 编辑灯光 in the top bar (2026-10-28, picture 6).
  const connection = ma2EditingConnectionStatus({ method, network, networkError: null, local, bridge });
  const connectLocal = async (): Promise<void> => {
    if (busy || disabled) return;
    const documentId = useDocumentStore.getState().documentId;
    setBusy(true);
    try {
      const connected = await connectLocalMa2();
      const target = connected.settings;
      if (!target) throw new Error('没有读到本机连接信息，请重新连接');
      notify(await prepareMa2Editing({ dataDirectory: '', network: { host: target.host, port: target.port, monitorPort: target.monitorPort, username: target.username } }, documentId));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  const locked = disabled || busy;
  return <section className="settings-stack" aria-label="MA2 连接设置">
    <Card title="连接" actions={method === 'midi' ? null : <StatusBadge name="MA2 控台" status={connection} />}>
      <Field label="连接方式">{props => <Select {...props} aria-label="MA2 连接方式" value={method} disabled={busy || networkBusy || disabled} onChange={(event) => void setMethod(event.target.value === 'midi' ? 'midi' : event.target.value === 'local' ? 'local' : 'network')}>
        <option value="midi">仅 MIDI（时间码与 Cue）</option><option value="network">实体控台 / 网络 onPC</option><option value="local">本机 onPC</option>
      </Select>}</Field>
      {method === 'midi' ? <Notice title="通过 MIDI 控制灯光" actions={<Button variant="primary" onClick={onAudioSettings}>选择 MIDI 端口</Button>}>
        节目播放时，控台按收到的时间码执行 Cue。要读取或同步 Cue，同机请选择“本机 onPC”并点“连接本机 onPC”，其他控台请选择“实体控台 / 网络 onPC”并连接。
      </Notice> : method === 'local' ? <>
        <p>连接本机地址 127.0.0.1，自动准备联动插件并读取节目 Cue，不需要网线或选择数据目录。请先在 onPC 中开启 Telnet（Login Enabled）。连接成功后使用同一套网络连接和同步设置。</p>
        {local.error ? <Notice tone="error">{local.error}</Notice> : null}
        <div className="settings-actions-row">
          <Button variant="primary" disabled={locked} onClick={() => void connectLocal()}>连接本机 onPC</Button>
          <Button variant="ghost" disabled={locked} onClick={() => void setMethod('network')}>查看地址和登录设置</Button>
        </div>
      </> : null}
      {networkVisited.current ? <div hidden={method !== 'network'}><Ma2NetworkSettings onStatus={setNetwork} onBusy={setNetworkBusy} disabled={disabled || method !== 'network'} notify={notify} maintenanceHost={method === 'network' ? maintenanceHost : null} onMaintenance={onMaintenance} /></div> : null}
    </Card>
    {method === 'midi' ? <Disclosure title="MIDI 连接说明" description="控台接收设置与 P1 歌曲导入">
      <p>联动台播放时，在“时间码输出”选择发给控台的 MIDI 接口。跟随 P1 时，让控台接收 P1 发出的时间码。播放后查看控台的时码槽是否在走，再打开起始码相同的 Timecode，查看执行器是否按顺序切换 Cue。</p>
      <p>只用 MIDI 时不需要 IP、登录账号或联动插件。接口可用只说明电脑这边正常，控台有没有收到时间码，要在控台上看。</p>
      <P1ProjectSyncPanel purpose="audio" disabled={locked} notify={notify} />
    </Disclosure> : null}
    {method === 'network' ? <Disclosure title="歌曲导入与同步"><Ma2CatalogSettings connected={networkConnected} method="network" directory="" disabled={disabled || networkBusy} notify={notify} onBusy={setBusy} /></Disclosure> : null}
    <Disclosure title="本机程序与预演"><Ma2ProgramSettings disabled={locked} notify={notify} /></Disclosure>
    {method === 'local' ? <Disclosure title="控台插件与安装说明">
      <p>插件已经内置，可以离线导出到 U 盘，在控台导入 XML 和 Lua 后运行。只用音乐和时间码跑灯时无需安装插件。</p>
      <div className="settings-actions-row"><Button variant="secondary" icon={Download} disabled={locked} onClick={() => void exportPlugin()}>导出控台插件</Button></div>
    </Disclosure> : null}
  </section>;
}
