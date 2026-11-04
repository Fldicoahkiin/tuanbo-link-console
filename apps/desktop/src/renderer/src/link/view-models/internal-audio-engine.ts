import type { IntegrationProfile, LinkProject } from '@tb/schema';

/** A song of this project sends MIDI timecode from the internal player: any song
 * with lighting or a P1 media show (playback only sends timecode, 2026-10-23). */
export function projectOutputsMtc(project: LinkProject | null): boolean {
  return project?.playbackSource === 'internal' && project.rundown.some(item => item.enabled && (Boolean(item.p1Media) || Boolean(item.lighting)));
}

/** One playback engine since 0.5.6: Windows native audio, so timecode and music
 * come from one sound-card clock (decided 2026-10-22; the browser engine was
 * removed 2026-10-30). Profiles may still name the old engine; it is ignored. */
export function playerEngineLabel(profile: IntegrationProfile | null, project: LinkProject | null): string {
  const outputsMtc = Boolean(profile?.internalPlayer?.mtcOutputPortProfileId) || projectOutputsMtc(project);
  return `Windows 原生音频${outputsMtc ? '（同时发送 MIDI 时间码）' : ''}`;
}

/** A device chosen under the removed browser engine is not a Windows endpoint, so
 * native audio plays on the Windows default device until the operator chooses again. */
export function legacyAudioDeviceNotice(route: IntegrationProfile['internalPlayer'] | undefined): string | null {
  return route?.audioEngine === 'browser' && !route.nativeAudioOutputDeviceId && route.audioOutputDeviceId !== 'default'
    ? '以前选的播放设备属于已经去掉的旧播放方式，现在声音从 Windows 默认播放设备出。要换设备，请在“音频输出设备”里重新选一次。'
    : null;
}
