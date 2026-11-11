import { useCallback, useEffect, useRef, type MouseEvent, type RefObject, type ReactNode } from 'react';
import './timeline-toolbar.css';
import { Button, Field, IconButton, MenuButton, MenuItem, MenuNote, Select } from '../ui';
import { TimelinePanelButton } from './TimelinePanelButton';
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Magnet,
  SlidersHorizontal,
  Maximize2,
  Pause,
  Play,
  Square,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import type { MtcFrameRate } from '@tb/schema';
import { playbackFramesPerSecond } from '@tb/core/link';
import { clampTimelineTime, formatTimelineTimecode, snapTimelineTime } from './timeline-geometry';
import type { ReferenceWaveformSource } from './ReferenceWaveform';
import { usePreviewMediaLifecycle } from './usePreviewMediaLifecycle';
import { keysBackToTimeline, nextEditPoint, previousEditPoint } from './timeline-commands';
import { usePlayheadEffect, usePlayheadPaint, type EditorPlayhead } from './editor-playhead';

type Props = {
  externalTransport?: boolean | undefined;
  onStop?: (() => void) | undefined;
  recordingControl?: ReactNode;
  tools?: ReactNode;
  stampControls?: ReactNode;
  outputControl?: ReactNode;
  displayControl?: ReactNode;
  compact?: boolean;
  wheelSeek?: { speed: number; setSpeed: (speed: number) => void } | undefined;
  frameRate: MtcFrameRate;
  durationMs: number;
  /** The readout and the local audio follow it every frame; the toolbar does not draw again (0.5.9 E2). */
  playhead: EditorPlayhead;
  playing: boolean;
  playbackReady?: boolean;
  referenceAudio: ReferenceWaveformSource | null;
  snapEnabled: boolean;
  snapDistance: number;
  onSnapDistanceChange: (distance: number) => void;
  editPoints: readonly number[];
  audioRef: RefObject<HTMLAudioElement>;
  onPlayheadChange: (milliseconds: number) => void;
  /** The play button (ReferenceTimeline's, which Space presses too). */
  onPlayPause: () => void;
  onPlayingChange: (playing: boolean) => void;
  onPlaybackError: (message: string) => void;
  onSnapEnabledChange: (enabled: boolean) => void;
  onZoomOut: () => void;
  onFit: () => void;
  onZoomIn: () => void;
};

export function TimelineToolbar(props: Props): JSX.Element {
  const audioUrl = props.referenceAudio?.url;
  usePreviewMediaLifecycle(props.audioRef, props.externalTransport ? null : audioUrl);
  const { audioRef, onPlaybackError, onPlayingChange, onPlayheadChange, playhead, playing } = props;
  useEffect(() => {
    const audio = audioRef.current;
    if (props.externalTransport || !audio || !audioUrl || !playing || props.playbackReady === false) return;
    const timer = window.setInterval(() => {
      onPlayheadChange(audio.currentTime * 1000);
      if (audio.ended) onPlayingChange(false);
    }, 16);
    return () => window.clearInterval(timer);
  }, [audioRef, audioUrl, playing, onPlayheadChange, onPlayingChange, props.playbackReady, props.externalTransport]);
  const externalTransport = props.externalTransport, playbackReady = props.playbackReady;
  usePlayheadEffect(playhead, useCallback((playheadMs: number) => {
    const audio = audioRef.current;
    if (externalTransport || !audio || !audioUrl) return;
    if (playbackReady === false) { audio.pause(); return; }
    const desiredSeconds = playheadMs / 1_000;
    // A render can run between the native pause-at-end and ended events.
    // Calling play() there restarts the media before lighting can flush its tail.
    if (audio.ended && playing && desiredSeconds > 0) {
      onPlayheadChange(audio.currentTime * 1000);
      onPlayingChange(false);
      return;
    }
    if (Math.abs(audio.currentTime - desiredSeconds) > (playing ? 0.75 : 0.04)) audio.currentTime = desiredSeconds;
    if (Number.isFinite(audio.duration) && desiredSeconds >= audio.duration) {
      audio.pause();
      if (playing) onPlayingChange(false);
      return;
    }
    if (!playing) {
      audio.pause();
      return;
    }
    if (!audio.paused) return;
    void audio.play().catch((error: unknown) => {
      onPlayingChange(false);
      onPlaybackError(error instanceof Error ? error.message : String(error));
    });
  }, [audioRef, audioUrl, onPlaybackError, onPlayheadChange, onPlayingChange, playing, playbackReady, externalTransport]));
  const readout = useRef<HTMLElement>(null);
  const frameRate = props.frameRate;
  usePlayheadPaint(playhead, useCallback((playheadMs: number) => {
    if (readout.current) readout.current.textContent = formatTimelineTimecode(playheadMs, frameRate);
  }, [frameRate]));

  const seekTo = (milliseconds: number): void => {
    props.onPlayingChange(false);
    const target = props.snapEnabled ? snapTimelineTime(milliseconds, props.frameRate) : milliseconds;
    props.onPlayheadChange(clampTimelineTime(target, props.durationMs));
  };
  const framesPerSecond = playbackFramesPerSecond(props.frameRate);
  const frameDurationMs = 1_000 / framesPerSecond;
  /** Any button on the toolbar, the ones the pages put in it too: after a mouse click the keys go back to the timeline. */
  const giveKeysBack = (event: MouseEvent<HTMLDivElement>): void => {
    if (keysBackToTimeline<Element>({ detail: event.detail, target: event.target instanceof Element ? event.target : null }, event.currentTarget)) {
      event.currentTarget.closest<HTMLElement>('.reference-timeline')?.focus({ preventScroll: true });
    }
  };

  const snapLabel = props.snapEnabled ? '关闭吸附' : '开启吸附';

  return <div className="timeline-toolbar" onClick={giveKeysBack}>
    <div className="timeline-edit-controls" role="group" aria-label="时间线剪辑工具">
      {props.stampControls}
      {props.tools ?? <>{props.recordingControl}
        <MenuButton label="定位" menuLabel="跳到剪辑点" title="跳到上一个或下一个剪辑点">{(close) => <>
          <MenuItem icon={ArrowLeftToLine} onSelect={() => { close(); seekTo(previousEditPoint(props.editPoints, playhead.read(), props.frameRate)); }}>上一剪辑点</MenuItem>
          <MenuItem icon={ArrowRightToLine} onSelect={() => { close(); seekTo(nextEditPoint(props.editPoints, playhead.read(), props.frameRate, props.durationMs)); }}>下一剪辑点</MenuItem>
          <MenuNote>Space 播放 / 暂停<br />← → 逐帧移动<br />S 在播放头切割<br />Ctrl+C / V 复制粘贴</MenuNote>
        </>}</MenuButton></>}
    </div>

    <div className="timeline-transport" role="group" aria-label="时间线播放控制">
      <IconButton label="回到时间线开头" title="回到开头（Home）" icon={SkipBack} onClick={() => seekTo(0)} />
      <IconButton label="上一帧" title="上一帧（←）" icon={StepBack} onClick={() => seekTo(playhead.read() - frameDurationMs)} />
      <IconButton className="timeline-play-button" variant="primary" label={props.playing ? '暂停时间线' : '播放时间线'} title={props.playing ? '暂停（Space）' : '播放（Space）'} icon={props.playing ? Pause : Play} onClick={() => props.onPlayPause()} />
      <IconButton label="下一帧" title="下一帧（→）" icon={StepForward} onClick={() => seekTo(playhead.read() + frameDurationMs)} />
      <IconButton label="跳到时间线结尾" title="跳到结尾" icon={SkipForward} onClick={() => seekTo(props.durationMs)} />
      {props.onStop ? <IconButton label="停止时间线" title="停止播放（Esc）" icon={Square} onClick={() => props.onStop?.()} /> : null}
      <code ref={readout} title="当前播放头时间码">{formatTimelineTimecode(playhead.read(), props.frameRate)}</code>
      {props.outputControl}
    </div>

    <div className="timeline-view-controls" role="group" aria-label="时间线视图">
      {props.displayControl}
      {props.wheelSeek ? <TimelinePanelButton label="时间线设置" icon={SlidersHorizontal}>
        <Field stacked label="滚轮移动速度">{(field) => <Select {...field} value={props.wheelSeek?.speed} onChange={event => props.wheelSeek?.setSpeed(Number(event.currentTarget.value))}>{[0.1, 0.25, 0.5, 1, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</Select>}</Field>
        <p className="timeline-panel-note">选中 Cue：滚轮移动 Cue<br />未选中：滚轮移动播放头<br />Shift + 滚轮：平移<br />Ctrl + 滚轮：缩放</p>
      </TimelinePanelButton> : null}
      {props.compact
        ? <IconButton className="timeline-snap-state" label={snapLabel} icon={Magnet} aria-pressed={props.snapEnabled} onClick={() => props.onSnapEnabledChange(!props.snapEnabled)} />
        : <Button variant="ghost" className="timeline-snap-state" icon={Magnet} aria-pressed={props.snapEnabled} aria-label={snapLabel} title={snapLabel} onClick={() => props.onSnapEnabledChange(!props.snapEnabled)}>吸附</Button>}
      {!props.compact ? <Select width="auto" className="timeline-snap-distance" aria-label="吸附强度" title="片段两端、机位边缘和播放头之间的吸附距离" value={props.snapDistance} disabled={!props.snapEnabled} onChange={(event) => props.onSnapDistanceChange(Number(event.currentTarget.value))}><option value={8}>轻 · 8 px</option><option value={14}>标准 · 14 px</option><option value={22}>强 · 22 px</option></Select> : null}
      <IconButton label="缩小时间线" icon={ZoomOut} onClick={() => props.onZoomOut()} />
      {props.compact
        ? <IconButton className="timeline-fit-button" label="适合节目时长" title="缩放至全部节目内容" icon={Maximize2} onClick={() => props.onFit()} />
        : <Button variant="ghost" className="timeline-fit-button" icon={Maximize2} aria-label="适合节目时长" title="缩放至全部节目内容" onClick={() => props.onFit()}>全部</Button>}
      <IconButton label="放大时间线" icon={ZoomIn} onClick={() => props.onZoomIn()} />
    </div>

    {!props.externalTransport && props.referenceAudio ? <audio
      className="timeline-audio-engine"
      ref={props.audioRef}
      preload="auto"
      src={props.referenceAudio.url}
      onError={() => { props.onPlayingChange(false); props.onPlaybackError('当前音频读不出来。请检查文件是否还在、是否损坏，或格式是否支持'); }}
      onEnded={(event) => {
        // The event may have been queued before a seek or a new playback.
        if (!event.currentTarget.ended) return;
        props.onPlayheadChange(event.currentTarget.currentTime * 1000);
        props.onPlayingChange(false);
      }}
    /> : null}
  </div>;
}
