import type { IntegrationProfile } from '@tb/schema';

export type MtcSendMode = 'standard' | 'quarter-frames';
export type MtcOutputSettings = { portName: string | null; sendMode: MtcSendMode };

/**
 * The timecode output of every place that sends MTC: formal playback, the editor's and the lighting
 * workbench's preview. Read here only, so a setting reaches all of them (2026-10-30: the previews
 * ignored the send mode, and a console that needs quarter frames only still got Full Frames there).
 */
export function mtcOutputSettings(profile: Pick<IntegrationProfile, 'midiPortProfiles' | 'internalPlayer'> | null | undefined): MtcOutputSettings {
  const id = profile?.internalPlayer?.mtcOutputPortProfileId;
  const port = id ? profile?.midiPortProfiles.find(entry => entry.id === id && entry.direction === 'output') : undefined;
  return { portName: port?.portName ?? null, sendMode: profile?.internalPlayer?.mtcSendMode ?? 'standard' };
}
