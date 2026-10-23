import type { RundownItem, MtcFrameRate } from '@tb/schema';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { formatTimelineTimecode } from './timeline-geometry';
import { usePlayerClock } from '../usePlayerClock';

export function MtcOutputStatus({ player, item, frameRate }: { player: ProjectPlayer; item: RundownItem; frameRate: MtcFrameRate }): JSX.Element {
  const { state } = player;
  const clock = usePlayerClock(player.view);
  const active = state.itemId === item.id;
  const sending = active && state.status === 'playing' && state.mtcSending;
  return <div className="mtc-output-status" aria-label="灯光时间码输出">
    <span>{sending ? '本机正在发送' : '时间码尚未发送'} · {active && state.mtcPortName ? state.mtcPortName : '播放时自动检测接口'} · {frameRate} fps</span>
    {sending && clock.mtcSentPositionMs != null ? <strong>{formatTimelineTimecode(clock.mtcSentPositionMs, frameRate, true)}</strong> : null}
    <small>{sending ? '控台接收状态需在控台 Timecode Slot 核对' : item.p1Media ? '沿用 P1 歌曲时间码；Cue 列表需在设备连接中扫描控台后导入' : '可在音频与 MIDI 指定灯光输出'}</small>
  </div>;
}
