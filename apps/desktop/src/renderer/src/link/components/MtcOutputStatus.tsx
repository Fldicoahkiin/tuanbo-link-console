import type { RundownItem, MtcFrameRate } from '@tb/schema';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { formatTimelineTimecode } from './timeline-geometry';
import { usePlayerClock } from '../usePlayerClock';
import { useConsoleFollowStore } from '../stores/console-follow-store';
import { consoleFollowStatus } from '../view-models/status-center';

export function MtcOutputStatus({ player, item, frameRate }: { player: ProjectPlayer; item: RundownItem; frameRate: MtcFrameRate }): JSX.Element {
  const { state } = player;
  const clock = usePlayerClock(player.view);
  const active = state.itemId === item.id;
  const sending = active && state.status === 'playing' && state.mtcSending;
  const follow = useConsoleFollowStore(value => value.follow);
  return <div className="mtc-output-status" aria-label="灯光时间码输出">
    <span>{sending ? '时间码已发出' : '时间码还没发送'} · {active && state.mtcPortName ? state.mtcPortName : '播放时自动检测接口'} · {frameRate} fps</span>
    {sending && clock.mtcSentPositionMs != null ? <strong>{formatTimelineTimecode(clock.mtcSentPositionMs, frameRate, true)}</strong> : null}
    <small>{sending ? consoleFollowStatus(follow).detail : item.p1Media ? '沿用 P1 歌曲时间码；Cue 列表需在设备连接中扫描控台后导入' : '可在音频与 MIDI 指定灯光输出'}</small>
  </div>;
}
