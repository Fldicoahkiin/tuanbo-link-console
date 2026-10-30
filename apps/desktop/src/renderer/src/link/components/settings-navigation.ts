import { AudioLines, Cable, MonitorUp, Palette, Monitor, SlidersHorizontal, Wrench, Play, Keyboard, Gauge, Film, Timer, Layers, Download, KeyRound, FileText, ListMusic, FolderArchive, LifeBuoy, MessageSquareWarning, FolderOpen, type LucideIcon } from 'lucide-react';

/**
 * Where each setting is saved decides its group (2026-10-30 rework): devices, playing and picture are
 * saved on this computer; 当前工程 is saved in the project file and travels with it.
 */
export const SETTINGS_GROUPS = [
  { id: 'devices', name: '设备连接', icon: Cable },
  { id: 'project', name: '当前工程', icon: FolderOpen },
  { id: 'playback', name: '播放', icon: AudioLines },
  { id: 'picture', name: '画面', icon: MonitorUp },
  { id: 'appearance', name: '外观与更新', icon: Palette },
  { id: 'support', name: '帮助与反馈', icon: LifeBuoy }
] as const;

/** machine: saved on this computer. project: saved in the project file. guide: explanations only. help: support tools. */
export type SettingsScope = 'machine' | 'project' | 'guide' | 'help';

export const SETTINGS_SECTIONS = [
  { id: 'audio', group: 'devices', scope: 'machine', name: '音频与 MIDI', detail: '声音从哪个设备放出来，时间码和 MIDI 走哪个接口', icon: AudioLines },
  { id: 'obs', group: 'devices', scope: 'machine', name: 'OBS Studio', detail: '连接 OBS，控制节目画面与声音', icon: Monitor },
  { id: 'ma2', group: 'devices', scope: 'machine', name: 'MA2 控台', detail: '连接灯光控台，读取和同步节目 Cue', icon: SlidersHorizontal },
  { id: 'virtual', group: 'devices', scope: 'machine', name: '虚拟 MIDI', detail: '让同一台电脑上的软件传递 MIDI 信号', icon: Cable },
  { id: 'maintenance', group: 'devices', scope: 'machine', name: '程序维护', detail: '修复 OBS 预览、设置程序启动位置', icon: Wrench },
  { id: 'songs', group: 'project', scope: 'project', name: '歌曲导入', detail: '导入 P1 工程或本地歌曲，建立节目单', icon: ListMusic },
  { id: 'source', group: 'project', scope: 'project', name: '播放主控', detail: '联动台播放或跟随 P1，视频素材要不要出声', icon: Play },
  { id: 'timecode', group: 'project', scope: 'project', name: '时间码', detail: '帧率、发送接口和每首歌的起始时间码都在这里', icon: Timer },
  { id: 'archives', group: 'project', scope: 'machine', name: '工程存档', detail: '同步前自动存档、存档位置与保留份数', icon: FolderArchive },
  { id: 'preferences', group: 'playback', scope: 'machine', name: '播放习惯', detail: '快捷操作、预载和淡入淡出', icon: Keyboard },
  { id: 'shortcuts', group: 'playback', scope: 'machine', name: '快捷键', detail: '灯光时间线快捷键设置、添加和修改', icon: Keyboard },
  { id: 'performance', group: 'picture', scope: 'machine', name: '监看与性能', detail: '预览与低功率运行', icon: Gauge },
  { id: 'seeking', group: 'picture', scope: 'machine', name: '视频定位', detail: '素材定位缓存', icon: Film },
  { id: 'workflow', group: 'picture', scope: 'guide', name: '场景工作方式', detail: '机位与素材的 OBS 场景关系', icon: Layers },
  { id: 'theme', group: 'appearance', scope: 'machine', name: '界面外观', detail: '深色、浅色或跟随系统', icon: Palette },
  { id: 'updates', group: 'appearance', scope: 'machine', name: '软件更新', detail: '版本检查与更新', icon: Download },
  { id: 'license', group: 'appearance', scope: 'machine', name: '本机授权', detail: '购买、订单与联网激活', icon: KeyRound },
  { id: 'feedback', group: 'support', scope: 'help', name: '问题反馈', detail: '写下看到的现象，连同诊断包一起发给售后', icon: MessageSquareWarning },
  { id: 'logs', group: 'support', scope: 'help', name: '运行日志', detail: '查看记录、打开日志文件夹、导出诊断包', icon: FileText }
] as const satisfies readonly { id: string; group: (typeof SETTINGS_GROUPS)[number]['id']; scope: SettingsScope; name: string; detail: string; icon: LucideIcon }[];
export type SettingsCategory = (typeof SETTINGS_SECTIONS)[number]['id'];
export type SettingsFocus = 'audio-output' | 'lighting-mtc' | 'lighting-actions' | 'obs-connection' | 'ma2-connection';
export type SettingsLocation = { category: SettingsCategory; focus?: SettingsFocus };

export function settingsSection(category: SettingsCategory): (typeof SETTINGS_SECTIONS)[number] {
  const section = SETTINGS_SECTIONS.find(entry => entry.id === category);
  if (!section) throw new Error(`没有这个设置页：${category}`);
  return section;
}
