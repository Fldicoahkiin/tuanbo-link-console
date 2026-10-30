import { useState } from 'react';
import { FilePlus2, FolderOpen } from 'lucide-react';
import { setProjectFrameRateCommand } from '@tb/core/link';
import { mtcFrameRateSchema, type MtcFrameRate } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { Button, Card, Dialog, Field, Notice, Select } from '../ui';
import { LightingPortField } from './LightingMidiSettings';
import { ScopeTag } from './SettingsPage';
import { SongMtcStart } from './SongMtcStart';
import { SongMtcStartInput } from './SongPlaybackProperties';
import { usePlayerConnections } from './usePlayerConnections';

type Notify = (message: string, tone?: 'info' | 'error') => void;
type PlayerConnections = ReturnType<typeof usePlayerConnections>;

/** The MIDI output the player sends its timecode to; shown on 音频与 MIDI and on 时间码. */
export function MtcPortField({ connections, disabled }: { connections: PlayerConnections; disabled: boolean }): JSX.Element {
  const { portName, outputs, saving, saved } = connections;
  const found = new Set(outputs.available).size;
  const help = saved === 'mtc' ? '已保存，下次播放时打开这个接口'
    : found ? `发给灯光控台，支持 loopMIDI 和 USB MIDI。已找到 ${found} 个输出接口` : '现在没有找到 MIDI 输出接口。插好接口或打开 loopMIDI 后点“刷新接口”';
  return <Field label="时间码输出" help={help}>{props => <Select {...props} aria-label="灯光 MIDI 输出" disabled={disabled || saving} value={portName} onChange={event => void connections.setMtcPort(event.currentTarget.value)}>
    <option value="">自动检测控台接口</option>
    {outputs.options.map(option => <option key={option.name} value={option.name} disabled={!option.available}>{option.name}{option.reason ? `（${option.reason}）` : ''}</option>)}
  </Select>}</Field>;
}

/**
 * 时间码 (2026-10-29 review: the port, the frame rate and every song's start on one page). The frame
 * rate and the starts are saved in the project; where the timecode goes is saved on this computer.
 */
export function TimecodeSettings({ internal, disabled, notify, onBusy, onCreate, onOpen }: {
  internal: boolean;
  disabled: boolean;
  notify: Notify;
  onBusy: (busy: boolean) => void;
  onCreate: () => void;
  onOpen: () => void;
}): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const execute = useDocumentStore(state => state.execute);
  const connections = usePlayerConnections({ disabled, notify, onBusy });
  const [pendingRate, setPendingRate] = useState<MtcFrameRate | null>(null);
  const [rateSaved, setRateSaved] = useState(false);
  const applyRate = (rate: MtcFrameRate): void => {
    try { execute(setProjectFrameRateCommand(rate)); setRateSaved(true); }
    catch (failure) { notify(failure instanceof Error ? failure.message : String(failure), 'error'); }
  };
  const chooseRate = (rate: MtcFrameRate): void => {
    if (!project || rate === project.timebase.frameRate) return;
    if (project.rundown.some(item => item.cues.length > 0)) setPendingRate(rate);
    else applyRate(rate);
  };
  const songs = project?.rundown ?? [];
  return <>
    {!project ? <Notice title="还没有打开工程" actions={<>
      <Button variant="primary" icon={FilePlus2} onClick={onCreate}>新建工程</Button>
      <Button variant="secondary" icon={FolderOpen} onClick={onOpen}>打开工程</Button>
    </>}>帧率和每首歌的起始时间码保存在工程里，新建或打开工程后才能设置。</Notice> : null}
    {project ? <Card title="帧率">
      <Field label="工程帧率" help={rateSaved ? '已改好，记得保存工程' : '和灯光控台、P1 用同一个帧率。只用来换算时间码，不改 OBS 的输出帧率'}>{props => <Select {...props} aria-label="工程帧率" width="auto" disabled={disabled} value={project.timebase.frameRate} onChange={event => {
        const rate = mtcFrameRateSchema.safeParse(event.currentTarget.value);
        if (rate.success) chooseRate(rate.data);
      }}>
        {mtcFrameRateSchema.options.map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
      </Select>}</Field>
    </Card> : null}
    {internal ? <Card title="发送" description="联动台播放时，按播放位置把时间码发给灯光控台。" actions={<ScopeTag scope="machine" />}>
      <MtcPortField connections={connections} disabled={disabled} />
      <Field label="发送方式" help={connections.saved === 'mode' ? '已保存，下一首起生效' : '控台收不到时间码时，改成“只发四分之一帧”再播一首试试：有的 USB MIDI 接口传不了整帧消息'}>{props => <Select {...props} aria-label="时间码发送方式" disabled={disabled || connections.saving} value={connections.sendMode} onChange={event => void connections.setSendMode(event.currentTarget.value === 'quarter-frames' ? 'quarter-frames' : 'standard')}>
        <option value="standard">标准（先发整帧定位）</option>
        <option value="quarter-frames">只发四分之一帧</option>
      </Select>}</Field>
      {connections.error ? <p className="settings-error" role="alert">{connections.error}</p> : null}
      <p>控台 Timecode 窗口里的时间跟着走，就说明收到了。</p>
    </Card> : <Card title="接收" description="跟随 P1 播放时，从 P1 接收时间码，再转给灯光。" actions={<ScopeTag scope="machine" />}>
      <LightingPortField id="p1-mtc" disabled={disabled} notify={notify} onBusy={onBusy} />
    </Card>}
    {project ? <Card title="每首歌的起始时间码" description="歌曲从这个时间码开始发送。和控台上时间码节目的起点一样，播放时就会自动跑灯；按回车保存，Esc 撤销。">
      {songs.length ? <table className="settings-table settings-song-starts">
        <thead><tr><th scope="col">#</th><th scope="col">歌曲</th><th scope="col">起始时间码</th><th scope="col">控台</th></tr></thead>
        <tbody>{songs.map((item, index) => <tr key={item.id}>
          <td>{index + 1}</td>
          <td className="settings-song-title" title={item.title}>{item.title}</td>
          <td><SongMtcStartInput item={item} notify={notify} className="ui-input" disabled={disabled} aria-label={`${item.title} 的 MTC 起始时间`} /></td>
          <td><SongMtcStart project={project} item={item} /></td>
        </tr>)}</tbody>
      </table> : <p>节目单里还没有歌曲。到「歌曲导入」导入 P1 工程或本地歌曲后，在这里填写起始时间码。</p>}
    </Card> : null}
    {pendingRate && project ? <Dialog title="修改工程帧率？" size="sm" onClose={() => setPendingRate(null)} actions={<>
      <Button variant="secondary" onClick={() => setPendingRate(null)}>取消</Button>
      <Button variant="primary" onClick={() => { applyRate(pendingRate); setPendingRate(null); }}>修改帧率</Button>
    </>}>
      <p>从 {project.timebase.frameRate} fps 改为 {pendingRate} fps 后，已有的 Cue 时间码会按新帧率换算。OBS 的输出帧率不变。</p>
    </Dialog> : null}
  </>;
}
