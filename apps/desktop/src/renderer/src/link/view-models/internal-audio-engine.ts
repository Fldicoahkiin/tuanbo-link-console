import type { IntegrationProfile, LinkProject } from '@tb/schema';

/** A song of this project sends MIDI timecode from the internal player: any song
 * with lighting or a P1 media show (playback only sends timecode, 2026-10-23). */
export function projectOutputsMtc(project: LinkProject | null): boolean {
  return project?.playbackSource === 'internal' && project.rundown.some(item => item.enabled && (Boolean(item.p1Media) || Boolean(item.lighting)));
}

export type InternalAudioEngine = { engine: 'browser' | 'native'; outputsMtc: boolean; blocked: string | null };

/** Operator decision 2026-10-22: Windows native audio. Settings no longer offer the
 * browser engine; a profile that still names it is shown with a switch to native.
 * The browser engine code is removed once native audio passes field acceptance. */
export function chosenAudioEngine(route: IntegrationProfile['internalPlayer'] | undefined): 'browser' | 'native' {
  return route?.audioEngine ?? 'native';
}

/** Decided 2026-10-22: playback that outputs MIDI timecode uses the native engine,
 * so timecode and music come from one sound-card clock. The engine is never
 * switched behind the operator's back: with timecode on and the browser engine
 * still chosen, playback is refused until the operator chooses the native engine. */
export function internalAudioEngine(profile: IntegrationProfile | null, project: LinkProject | null): InternalAudioEngine {
  const engine = chosenAudioEngine(profile?.internalPlayer);
  const outputsMtc = Boolean(profile?.internalPlayer?.mtcOutputPortProfileId) || projectOutputsMtc(project);
  return { engine, outputsMtc, blocked: outputsMtc && engine !== 'native'
    ? '已开启 MIDI 时间码输出，需要用 Windows 原生音频播放，时间码才能和音乐保持同步。请在“播放设置”里点“改用 Windows 原生音频”后再播放。' : null };
}

export function internalAudioEngineLabel({ engine, outputsMtc }: InternalAudioEngine): string {
  return engine === 'native' ? `Windows 原生音频${outputsMtc ? '（同时发送 MIDI 时间码）' : ''}` : '浏览器音频';
}
