import { AudioLines, Cable, MonitorUp, Palette, Monitor, SlidersHorizontal, Wrench, Play, Keyboard, Gauge, Film, Timer, Layers, Download, KeyRound } from 'lucide-react';

export const SETTINGS_GROUPS = [
  { id: 'devices', name: '设备连接', icon: Cable },
  { id: 'playback', name: '播放', icon: AudioLines },
  { id: 'picture', name: '画面与同步', icon: MonitorUp },
  { id: 'appearance', name: '外观与更新', icon: Palette }
] as const;
export const SETTINGS_SECTIONS = [
  { id: 'obs', group: 'devices', name: 'OBS Studio', detail: '画面与声音输出', icon: Monitor },
  { id: 'ma2', group: 'devices', name: 'MA2 控台', detail: '灯光与控台通信', icon: SlidersHorizontal },
  { id: 'audio', group: 'devices', name: '音频与 MIDI', detail: '声音线路与时间码', icon: AudioLines },
  { id: 'virtual', group: 'devices', name: '虚拟 MIDI', detail: 'loopMIDI 通道管理', icon: Cable },
  { id: 'maintenance', group: 'devices', name: '高级与诊断', detail: '程序路径与设备详情', icon: Wrench },
  { id: 'source', group: 'playback', name: '播放主控', detail: '选择内部主控或跟随 P1', icon: Play },
  { id: 'preferences', group: 'playback', name: '播放习惯', detail: '快捷操作、预载和淡入淡出', icon: Keyboard },
  { id: 'shortcuts', group: 'playback', name: '快捷键', detail: '灯光时间线快捷键设置、添加和修改', icon: Keyboard },
  { id: 'performance', group: 'picture', name: '监看与性能', detail: '预览与低功率运行', icon: Gauge },
  { id: 'seeking', group: 'picture', name: '视频定位', detail: '素材定位缓存', icon: Film },
  { id: 'timecode', group: 'picture', name: '时间码同步', detail: '工程时间码帧率', icon: Timer },
  { id: 'workflow', group: 'picture', name: '场景工作方式', detail: '机位与素材的 OBS 场景关系', icon: Layers },
  { id: 'theme', group: 'appearance', name: '界面外观', detail: '深色、浅色或跟随系统', icon: Palette },
  { id: 'updates', group: 'appearance', name: '软件更新', detail: '版本检查与更新', icon: Download },
  { id: 'license', group: 'appearance', name: '本机授权', detail: '购买、订单与联网激活', icon: KeyRound }
] as const;
export type SettingsCategory = (typeof SETTINGS_SECTIONS)[number]['id'];
export type DeviceSettingsCategory = 'obs' | 'ma2' | 'audio' | 'virtual' | 'maintenance';
export function isDeviceSettingsCategory(category: SettingsCategory): category is DeviceSettingsCategory {
  return SETTINGS_SECTIONS.find((section) => section.id === category)?.group === 'devices';
}
