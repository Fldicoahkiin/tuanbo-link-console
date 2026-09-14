import { z } from 'zod';
import { rundownItemSchema, type LinkAction, type LinkCue, type MtcFrameRate, type ReferenceAudio } from '@tb/schema';
import { frameNumberToTimecode, millisecondsToFrameNumber } from './mtc-timecode';
import type { LinkCommand } from './link-command';
import { parseLinkProject } from '@tb/schema';

const cueSchema = z.object({ time: z.number().nonnegative(), scene: z.string().default(''), midi_enabled: z.boolean().default(false),
  midi_type: z.enum(['note', 'cc', 'program', 'msc']).default('note'), midi_channel: z.number().int().min(1).max(16).default(1),
  midi_note_cc: z.number().int().min(0).max(127).default(0), midi_value: z.number().int().min(0).max(127).default(127) });
const mediaSchema = z.object({ file_path: z.string().min(1), file_name: z.string().optional(), duration: z.number().positive(),
  volume: z.number().min(0).max(100).default(100), play_action: z.enum(['pause', 'next', 'loop', 'stop']).default('next'), loop: z.boolean().default(false),
  start_time: z.number().nonnegative().default(0), end_time: z.number().nonnegative().default(0), mtc_offset: z.number().nonnegative().default(0),
  shortcut_key: z.string().default(''), obs_scene: z.string().default(''), scene_cues: z.array(cueSchema).default([]) });
export const ibcProjectSchema = z.object({ name: z.string().default('IBC 工程'), version: z.string().optional(),
  playlist_manager: z.object({ playlists: z.array(z.object({ name: z.string().min(1), items: z.array(mediaSchema) })) }) });
export type IbcProject = z.infer<typeof ibcProjectSchema>;

export function importIbcCommand(source: IbcProject, audio: ReferenceAudio[], frameRate: MtcFrameRate, midiPortProfileId?: string): LinkCommand {
  const lists = source.playlist_manager.playlists.map((list) => ({ id: crypto.randomUUID(), name: list.name }));
  let index = 0;
  const items = source.playlist_manager.playlists.flatMap((list, listIndex) => list.items.map((media) => {
    const referenceAudio = audio[index++];
    if (!referenceAudio) throw new Error('IBC 素材导入不完整');
    const cues: LinkCue[] = media.scene_cues.map((cue, cueIndex) => {
      const actions: LinkAction[] = [];
      if (cue.scene) actions.push({ id: crypto.randomUUID(), label: cue.scene, kind: 'obs.setProgramScene', sceneName: cue.scene });
      if (cue.midi_enabled) {
        if (!midiPortProfileId) throw new Error('IBC 含 MIDI 动作，请先配置灯光 MIDI 输出');
        const number = cue.midi_note_cc || cueIndex + 1;
        const base = { id: crypto.randomUUID(), label: `IBC MIDI ${number}`, portProfileId: midiPortProfileId, channel: cue.midi_channel };
        if (cue.midi_type === 'note') {
          if (!cue.midi_value) throw new Error('IBC Note On 力度为 0，请在原工程修正后导入');
          actions.push({ ...base, kind: 'midi.noteOn', note: number, velocity: cue.midi_value, durationMs: 100 });
        } else if (cue.midi_type === 'cc') actions.push({ ...base, kind: 'midi.controlChange', controller: number, value: cue.midi_value });
        else if (cue.midi_type === 'program') actions.push({ ...base, kind: 'midi.programChange', program: number });
        else actions.push({ ...base, kind: 'midi.showControl', deviceId: 127, commandFormat: 1, command: 'go', cueNumber: String(number) });
      }
      return { id: crypto.randomUUID(), name: cue.scene || `切换点 ${cueIndex + 1}`, enabled: true, notes: '',
        timecode: frameNumberToTimecode(millisecondsToFrameNumber(cue.time * 1000, frameRate), frameRate), actions };
    });
    if (media.obs_scene && !media.scene_cues.length) cues.unshift({ id: crypto.randomUUID(), name: '初始场景', enabled: true, notes: '',
      timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions: [{ id: crypto.randomUUID(), label: media.obs_scene, kind: 'obs.setProgramScene', sceneName: media.obs_scene }] });
    return rundownItemSchema.parse({ id: crypto.randomUUID(), playlistId: lists[listIndex]?.id, title: media.file_name || media.file_path.split(/[\\/]/).at(-1), referenceAudio,
      playback: { volume: media.volume, endAction: media.loop ? 'loop' : media.play_action, startMs: Math.round(media.start_time * 1000), endMs: Math.round(media.end_time * 1000),
        mtcOffsetMs: Math.round(media.mtc_offset * 1000), shortcut: convertShortcut(media.shortcut_key) }, cues });
  }));
  if (index !== audio.length) throw new Error('IBC 素材数量不匹配');
  return { id: crypto.randomUUID(), label: '导入 IBC 工程', execute(project) {
    if (project.timebase.frameRate !== frameRate) throw new Error('导入期间帧率已改变，请重新导入');
    return parseLinkProject({ ...project, updatedAt: new Date().toISOString(), playbackSource: 'internal',
      obsOutputMode: project.rundown.length ? project.obsOutputMode : 'scenes',
      playlists: [...project.playlists ?? [], ...lists], rundown: [...project.rundown, ...items] });
  }, undo: (before) => structuredClone(before) };
}

function convertShortcut(value: string): string {
  if (!value) return '';
  const parts = value.split('+'); const key = parts.pop() ?? '';
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : /^(F[1-9]|F1[0-2])$/.test(key) ? key : null;
  if (!code || parts.some((part) => !['Ctrl', 'Alt', 'Shift'].includes(part))) throw new Error(`IBC 快捷键不支持：${value}；请在原工程清除后重新导入`);
  return [...['Ctrl', 'Alt', 'Shift'].filter((part) => parts.includes(part)), code].join('+');
}
