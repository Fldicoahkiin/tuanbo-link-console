import type { IntegrationProfile, LinkProject } from '@tb/schema';

/** A song of this project sends MIDI timecode from the internal player: console
 * timecode lighting or a P1 media show. Network and direct lighting do not. */
export function projectOutputsMtc(project: LinkProject | null): boolean {
  return project?.playbackSource === 'internal' && project.rundown.some(item => item.enabled && item.lighting?.outputMode !== 'network'
    && item.lighting?.outputMode !== 'direct' && (Boolean(item.p1Media) || item.lighting?.outputMode === 'timecode'));
}

export type InternalAudioEngine = { engine: 'browser' | 'native'; outputsMtc: boolean; blocked: string | null };

/** Operator decision 2026-10-22: Windows native audio unless a profile chose otherwise. */
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
    ? '已启用 MIDI 时间码输出：正式播放需使用 Windows 原生音频，时间码与音乐出自同一声卡时钟。请在“播放设置 › 高级音频 · 播放引擎”选择 Windows 原生音频后再播放。' : null };
}

export function internalAudioEngineLabel({ engine, outputsMtc }: InternalAudioEngine): string {
  return engine === 'native' ? `Windows 原生音频${outputsMtc ? '（输出 MIDI 时间码）' : ''}` : '浏览器音频';
}
