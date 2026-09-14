import { setPlaybackSourceCommand, setProjectFrameRateCommand } from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { Film, Layers, LockKeyhole, ScanLine } from 'lucide-react';

type Props = { section: 'playback' | 'seeking' | 'timecode' | 'workflow'; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void };


export function ProjectSettings({ section, disabled, notify }: Props): JSX.Element {
  const preciseSeeking = useDisplayPreferences((state) => state.preciseSeeking);
  const project = useDocumentStore((state) => state.project);
  const execute = useDocumentStore((state) => state.execute);
  if (!project) return <p className="settings-note">新建或打开工程后，可调整工程设置。</p>;
  const changeFrameRate = (rate: MtcFrameRate): void => {
    if (rate === project.timebase.frameRate) return;
    if (project.rundown.some((item) => item.cues.length > 0) && !window.confirm('修改帧率会按新帧率解释已有时间码。继续修改？')) return;
    try { execute(setProjectFrameRateCommand(rate)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  return <fieldset className="settings-form project-settings-fields" disabled={disabled}>
    {disabled ? <p className="settings-note"><LockKeyhole size={14} />停止播放后可修改设置</p> : null}
    {section === 'playback' ? <label className="settings-row"><span>播放控制<small>音乐、画面与灯光的播放主控</small></span><select aria-label="播放主控模式" value={project.playbackSource === 'internal' ? 'internal' : 'p1'} onChange={(event) => execute(setPlaybackSourceCommand(event.currentTarget.value === 'internal' ? 'internal' : 'p1'))}><option value="internal">本软件播放</option><option value="p1">跟随 P1</option></select></label> : null}
    {section === 'seeking' ? <><label className="settings-row"><span>逐帧定位缓存</span><input type="checkbox" role="switch" aria-label="视频定位缓存" checked={preciseSeeking} onChange={(event) => { try { useDisplayPreferences.getState().setPreciseSeeking(event.currentTarget.checked); } catch (error) { notify(`定位设置保存失败：${String(error)}`, 'error'); } }} /></label><p className="settings-note">保留原素材，首次准备会生成定位副本，占用额外磁盘空间。下次预检时应用。</p>{!preciseSeeking ? <p className="device-error">已使用原文件：部分编码可能无法准确定位或播放。</p> : null}</> : null}
    {section === 'timecode' ? <><label className="settings-row"><span>工程帧率</span><select aria-label="工程帧率" value={project.timebase.frameRate} onChange={(event) => changeFrameRate(event.currentTarget.value as MtcFrameRate)}>{(['24', '25', '29.97df', '30'] as const).map((rate) => <option key={rate} value={rate}>{rate} fps</option>)}</select></label><p className="settings-note">用于解释时间线与 Cue 时间码，不改变 OBS 的输出帧率。请与灯光控台或 P1 保持一致。</p></> : null}
    {section === 'workflow' ? <div className="scene-workflow-notes">
      <article><Layers /><div><h3>机位切换</h3><p>一个机位对应一个 OBS 场景，保留已有裁剪、拉腿与滤镜。</p></div></article>
      <article><Film /><div><h3>素材与恢复</h3><p>每个素材使用独立场景。机位结束后，回到下层视频的对应位置。</p></div></article>
      <article><ScanLine /><div><h3>画布与尺寸</h3><p>分辨率、画面方向在 OBS 设置。素材与机位时长在时间线调整。</p></div></article>
    </div> : null}
  </fieldset>;
}
