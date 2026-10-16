import { useState } from 'react';
import { Button } from './Button';
import { SettingsActions, SettingsConfirm, SettingsFeedback, SettingsSwitch } from './SettingsControls';
import type { SettingsCategory } from './settings-navigation';
import { setPlaybackSourceCommand, setProjectFrameRateCommand } from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { Film, Layers, LockKeyhole, ScanLine } from 'lucide-react';

type Props = { onCreate?: () => void; onOpen?: () => void; onNavigate?: (category: SettingsCategory) => void; section: 'playback' | 'seeking' | 'timecode' | 'workflow'; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void };


export function ProjectSettings({ section, disabled, notify, onCreate, onOpen, onNavigate }: Props): JSX.Element {
  const [pendingRate, setPendingRate] = useState<MtcFrameRate | null>(null);
  const [message, setMessage] = useState('');
  const preciseSeeking = useDisplayPreferences((state) => state.preciseSeeking);
  const project = useDocumentStore((state) => state.project);
  const execute = useDocumentStore((state) => state.execute);
  if (!project && (section === 'playback' || section === 'timecode')) return <SettingsFeedback>新建或打开工程后，可调整工程设置。<SettingsActions>{onCreate ? <Button onClick={onCreate}>新建工程</Button> : null}{onOpen ? <Button onClick={onOpen}>打开工程</Button> : null}</SettingsActions></SettingsFeedback>;
  const changeFrameRate = (rate: MtcFrameRate): void => {
    if (!project || rate === project.timebase.frameRate) return;
    if (project.rundown.some((item) => item.cues.length > 0)) { setPendingRate(rate); return; }
    try { execute(setProjectFrameRateCommand(rate)); setMessage('已应用到工程，请保存工程文件。'); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  return <fieldset className="settings-form project-settings-fields" disabled={disabled}>
    {disabled ? <p className="settings-note"><LockKeyhole size={14} />停止播放后可修改设置</p> : null}
    {section === 'playback' && project ? <><div className="settings-choice-group" role="radiogroup" aria-label="播放主控模式">{([{ value: 'internal', title: '本软件播放', help: '播放正式音乐，并向灯光输出时间码。' }, { value: 'p1', title: '跟随 P1', help: '以 P1 的真实 MIDI 时间码跟随节目。' }] as const).map(option => <label className="settings-choice" key={option.value}><input type="radio" name="playback-source" checked={project.playbackSource === option.value} onChange={() => { execute(setPlaybackSourceCommand(option.value)); setMessage('已应用到工程，请保存工程文件。'); }} /><span>{option.title}<small>{option.help}</small></span></label>)}</div><Button className="secondary-button" onClick={() => onNavigate?.('audio')}>配置音频与 MIDI</Button></> : null}
    {section === 'seeking' ? <><SettingsSwitch label="逐帧定位缓存" aria-label="视频定位缓存" checked={preciseSeeking} onChange={(event) => { try { useDisplayPreferences.getState().setPreciseSeeking(event.currentTarget.checked); } catch (error) { notify(`定位设置保存失败：${String(error)}`, 'error'); } }} /><p className="settings-note">保留原素材，首次准备会生成定位副本，占用额外磁盘空间。下次预检时应用。</p>{!preciseSeeking ? <SettingsFeedback tone="warning">已使用原文件：部分编码可能无法准确定位或播放。</SettingsFeedback> : null}</> : null}
    {section === 'timecode' && project ? <><label className="settings-row"><span>工程帧率</span><select aria-label="工程帧率" value={project.timebase.frameRate} onChange={(event) => changeFrameRate(event.currentTarget.value as MtcFrameRate)}>{(['24', '25', '29.97df', '30'] as const).map((rate) => <option key={rate} value={rate}>{rate} fps</option>)}</select></label><p className="settings-note">用于解释时间线与 Cue 时间码，不改变 OBS 的输出帧率。请与灯光控台或 P1 保持一致。</p></> : null}
    {section === 'workflow' ? <div className="scene-workflow-notes">
      <article><Layers /><div><h3>机位切换</h3><p>一个机位对应一个 OBS 场景，保留已有裁剪、拉腿与滤镜。</p></div></article>
      <article><Film /><div><h3>素材与恢复</h3><p>每个素材使用独立场景。机位结束后，回到下层视频的对应位置。</p></div></article>
      <article><ScanLine /><div><h3>画布与尺寸</h3><p>分辨率、画面方向在 OBS 设置。素材与机位时长在时间线调整。</p></div></article>
    </div> : null}
    {message ? <p role="status" className="settings-note">{message}</p> : null}
    {pendingRate && project ? <SettingsConfirm title="修改工程帧率？" confirmLabel="修改帧率" onClose={() => setPendingRate(null)} onConfirm={() => { try { execute(setProjectFrameRateCommand(pendingRate)); setMessage('已应用到工程，请保存工程文件。'); } catch (error) { notify(String(error), 'error'); } setPendingRate(null); }}>从 {project.timebase.frameRate} fps 改为 {pendingRate} fps 后，已有 Cue 时间码将按新帧率解释。OBS 输出帧率保持不变。</SettingsConfirm> : null}
  </fieldset>;
}
