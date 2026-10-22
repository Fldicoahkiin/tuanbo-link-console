import { AudioLines, Cable, MonitorUp, Palette, Monitor, SlidersHorizontal, Wrench, Play, Keyboard, Gauge, Film, Timer, Layers, Download, KeyRound, FileText, ListMusic, FolderArchive } from 'lucide-react';

export const SETTINGS_GROUPS = [
  { id: 'devices', name: '设备连接', icon: Cable },
  { id: 'playback', name: '播放', icon: AudioLines },
  { id: 'picture', name: '画面与同步', icon: MonitorUp },
  { id: 'appearance', name: '外观与更新', icon: Palette }
] as const;
export const SETTINGS_SECTIONS = [
  { id: 'songs', group: 'devices', name: '歌曲导入', detail: '导入 P1 工程或本地歌曲，建立节目单', icon: ListMusic },
  { id: 'obs', group: 'devices', name: 'OBS Studio', detail: '连接 OBS，控制节目画面与声音', icon: Monitor },
  { id: 'ma2', group: 'devices', name: 'MA2 控台', detail: '连接灯光控台，读取和同步节目 Cue', icon: SlidersHorizontal },
  { id: 'audio', group: 'devices', name: '音频与 MIDI', detail: '选择声音从哪里播放、时间码发送到哪里', icon: AudioLines },
  { id: 'virtual', group: 'devices', name: '虚拟 MIDI', detail: '让同一台电脑上的软件传递 MIDI 信号', icon: Cable },
  { id: 'maintenance', group: 'devices', name: '程序维护', detail: '修复 OBS 预览、设置程序启动位置', icon: Wrench },
  { id: 'logs', group: 'devices', name: '运行日志', detail: '查看记录与导出现场诊断', icon: FileText },
  { id: 'archives', group: 'devices', name: '工程存档', detail: '同步前自动存档、存档位置与保留份数', icon: FolderArchive },
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
export type SettingsFocus = 'audio-output' | 'lighting-mtc' | 'lighting-actions' | 'obs-connection' | 'ma2-connection';
export type SettingsLocation = { category: SettingsCategory; focus?: SettingsFocus };
export type DeviceSettingsCategory = 'songs' | 'obs' | 'ma2' | 'audio' | 'virtual' | 'maintenance' | 'logs' | 'archives';
export const DEVICE_WORKFLOW_GROUPS = [
  { name: '歌曲准备', entries: ['songs'] },
  { name: '设备连接', entries: ['audio', 'obs', 'ma2'] },
  { name: '辅助工具', entries: ['virtual', 'maintenance', 'logs', 'archives'] }
] as const;

export function settingsScope(category: SettingsCategory): string {
  if (category === 'source' || category === 'timecode' || category === 'songs') return '工程设置';
  if (category === 'ma2' || category === 'preferences') return '含两类设置';
  if (category === 'workflow') return '使用说明';
  return '本机设置';
}
export function isDeviceSettingsCategory(category: SettingsCategory): category is DeviceSettingsCategory {
  return SETTINGS_SECTIONS.find((section) => section.id === category)?.group === 'devices';
}
