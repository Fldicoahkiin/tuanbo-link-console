import { useState } from 'react';
import { ArrowRight, Film, FilePlus2, FolderOpen, Layers, ScanLine } from 'lucide-react';
import { setInternalVideoAudioCommand, setPlaybackSourceCommand } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { Button, Card, ChoiceGroup, Notice, Switch } from '../ui';
import type { SettingsCategory } from './settings-navigation';

type Notify = (message: string, tone?: 'info' | 'error') => void;
/** A project without a source predates 联动台播放 and follows P1. */
type PlaybackSource = NonNullable<LinkProject['playbackSource']>;

const savedInProject = '已改好，记得保存工程';

/** 播放主控: who plays the music, and whether video clips keep their own sound. Saved in the project. */
export function PlaybackSourceSettings({ disabled, notify, onCreate, onOpen, onNavigate }: {
  disabled: boolean;
  notify: Notify;
  onCreate: () => void;
  onOpen: () => void;
  onNavigate: (category: SettingsCategory) => void;
}): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const execute = useDocumentStore(state => state.execute);
  const [saved, setSaved] = useState(false);
  if (!project) return <Notice title="还没有打开工程" actions={<>
    <Button variant="primary" icon={FilePlus2} onClick={onCreate}>新建工程</Button>
    <Button variant="secondary" icon={FolderOpen} onClick={onOpen}>打开工程</Button>
  </>}>播放方式保存在工程里，新建或打开工程后才能设置。</Notice>;
  const run = (change: () => void): void => {
    try { change(); setSaved(true); }
    catch (failure) { notify(failure instanceof Error ? failure.message : String(failure), 'error'); }
  };
  return <>
    <Card title="谁来播放音乐" actions={<Button variant="ghost" size="sm" icon={ArrowRight} onClick={() => onNavigate('audio')}>音频与 MIDI</Button>}>
      <ChoiceGroup<PlaybackSource> label="播放方式" value={project.playbackSource ?? 'p1'} disabled={disabled} onChange={source => run(() => execute(setPlaybackSourceCommand(source)))} choices={[
        { value: 'internal', title: '联动台播放', help: '联动台播放音乐，同时把时间码发给灯光控台。' },
        { value: 'p1', title: '跟随 P1', help: 'P1 播放音乐，联动台按 P1 发来的时间码跟着走。' }
      ]} />
    </Card>
    <Card title="视频原声">
      <Switch label="播放视频素材自带的声音" aria-label="同时播放视频素材原声" help="联动台播放时，视频素材的声音和音乐一起放出来；关闭后只放音乐" disabled={disabled}
        checked={project.internalVideoAudio === true} onChange={event => { const enabled = event.currentTarget.checked; run(() => execute(setInternalVideoAudioCommand(enabled))); }} />
    </Card>
    {saved ? <p className="settings-saved" role="status">{savedInProject}</p> : null}
  </>;
}

/** 视频定位: whether clips get a copy that seeks to the exact frame. Saved on this computer. */
export function SeekingSettings({ notify }: { notify: Notify }): JSX.Element {
  const preciseSeeking = useDisplayPreferences(state => state.preciseSeeking);
  return <Card>
    <Switch label="逐帧定位缓存" aria-label="视频定位缓存" help="原素材不变。第一次准备时生成一份便于定位的副本，会多占一些磁盘空间；下次开播前检查时生效"
      checked={preciseSeeking} onChange={event => {
        try { useDisplayPreferences.getState().setPreciseSeeking(event.currentTarget.checked); }
        catch (failure) { notify(`定位设置没有保存成功：${String(failure)}`, 'error'); }
      }} />
    {!preciseSeeking ? <Notice tone="warning">现在直接用原文件定位：有些编码格式可能定位不准或放不出来。</Notice> : null}
  </Card>;
}

const sceneGuide = [
  { icon: Layers, title: '机位切换', text: '一个机位对应一个 OBS 场景，保留已有的裁剪、拉腿和滤镜。' },
  { icon: Film, title: '素材与恢复', text: '每个素材用自己的场景。机位片段结束后，回到下层视频的对应位置。' },
  { icon: ScanLine, title: '画布与尺寸', text: '分辨率和画面方向在 OBS 里设置；素材和机位的时长在时间线上调整。' }
] as const;

/** 场景工作方式: how cameras and clips map to OBS scenes. Nothing to set. */
export function SceneWorkflowGuide(): JSX.Element {
  return <ul className="settings-guide">
    {sceneGuide.map(({ icon: Icon, title, text }) => <li key={title}><Icon aria-hidden="true" /><div><h2>{title}</h2><p>{text}</p></div></li>)}
  </ul>;
}
