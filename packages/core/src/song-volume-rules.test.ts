import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject, type NativeObsPrepare, type NativeObsStatus, type NativePlayerControl, type NativePlayerPrepare, type NativePlayerStatus } from '@tb/schema';
import { emptyInternalPlayerState, type InternalPlayerState } from './program-player';
import { NativeProgramPlayer } from './native-program-player';
import { defaultItemPlayback, setItemVolumeCommand } from './link-command';
import { SongVolumeGesture } from './song-volume-gesture';
import { programTimeOrigin } from './ma2-time-origin';

/**
 * The song-volume rules the operator set on 2026-11-09 (docs/SONG_VOLUME.md): "每一个节目我可以给他一个单独的音量，
 * 可以保存，而不是统一所有节目都是一个音量". A change that breaks one of them fails here.
 */

function song(id: string, playback: LinkProject['rundown'][number]['playback']) {
  return { id, title: `歌曲${id}`, referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 10_000 },
    ...(playback ? { playback } : {}) };
}

function project(): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('每首歌的音量'), playbackSource: 'internal', rundown: [
    song('甲', { volume: 80, startMs: 0, endMs: 0, mtcOffsetMs: 480_000, shortcut: '', endAction: 'pause' }),
    song('乙', { volume: 40, startMs: 0, endMs: 0, mtcOffsetMs: 500_000, shortcut: '', endAction: 'pause' })] });
}

/** A program over a fake audio engine that keeps the gain it was last told. */
function program(opened: LinkProject) {
  let status: NativePlayerStatus | null = null, listener: ((value: NativePlayerStatus) => void) | null = null;
  let state: InternalPlayerState = { ...emptyInternalPlayerState };
  const emit = (patch: Partial<NativePlayerStatus>): NativePlayerStatus => { status = { ...status!, ...patch }; listener?.(status); return status; };
  const api = {
    preloadNativeObs: vi.fn(() => Promise.resolve()), cancelNativeObsPreload: vi.fn(() => Promise.resolve()),
    onNativeObsStatus: () => () => undefined, stopNativeObs: vi.fn(() => Promise.resolve()),
    prepareNativeObs: (request: NativeObsPrepare): Promise<NativeObsStatus> => Promise.resolve({ version: 1, sessionId: request.sessionId,
      generation: request.generation, itemId: request.snapshot.item.id, revision: request.snapshot.revision, state: 'ready', reason: null,
      currentCueId: null, nextCueId: null, pendingCount: 0, positionMs: 0 }),
    onNativePlaybackStatus: (receive: (value: NativePlayerStatus) => void) => { listener = receive; return () => { listener = null; }; },
    getNativePlaybackDevices: () => Promise.resolve({ protocol: 4 as const, audio: [], midiOutputs: [], midiInputs: [] }),
    prepareNativePlayback: vi.fn((request: NativePlayerPrepare): Promise<NativePlayerStatus> => {
      const s = request.snapshot;
      status = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: s.itemId, status: 'ready', positionMs: s.positionMs,
        offsetMs: s.offsetMs, sampleRate: s.sampleRate, enginePid: 1, engineTitle: 'TBLINK Audio 1', mtcPortName: null, mtcSent: 0,
        audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: s.volume, analysis: null };
      return Promise.resolve(emit({}));
    }),
    controlNativePlayback: vi.fn((command: NativePlayerControl): Promise<NativePlayerStatus> => {
      const patch: Partial<NativePlayerStatus> = { generation: command.generation };
      switch (command.kind) {
        case 'play': patch.status = 'playing'; break;
        case 'pause': patch.status = 'paused'; break;
        case 'seek': patch.status = 'paused'; patch.positionMs = command.positionMs; break;
        case 'stop': patch.status = 'stopped'; break;
        case 'stop-mtc': break;
        case 'volume': patch.gain = command.volume; break;
      }
      return Promise.resolve(emit(patch));
    })
  };
  const dependencies = { prepare: () => Promise.resolve(), ingest: () => Promise.resolve(), stop: () => Promise.resolve(), pause: () => Promise.resolve(),
    resolveAudio: () => Promise.resolve('unused'), configuration: () => ({ outputDeviceId: 'default', mtcPortName: null, audioSampleRate: 48000 as const }),
    changed: (next: InternalPlayerState) => { state = next; }, notice: vi.fn(), closedFault: vi.fn() };
  const lighting = { change: () => Promise.resolve({ failed: [] }), stop: () => Promise.resolve({ failed: [] }) };
  const player = new NativeProgramPlayer(opened, 'C:/show/每首歌的音量.tblink', 1, dependencies, api, lighting);
  /** What the engine plays at now, 0–100. */
  const gain = async (): Promise<number> => { await new Promise(resolve => setTimeout(resolve, 0)); return Math.round((status?.gain ?? Number.NaN) * 100); };
  return { player, api, gain, state: () => state };
}

describe('一次拖动是一次修改、一步撤销', () => {
  it('拖动中只试听，松手才保存一次；撤销一步回到拖动前', () => {
    const gesture = new SongVolumeGesture(), before = project();
    gesture.press('甲');
    const moves = [70, 60, 50].map(volume => gesture.input('甲', volume));
    expect(moves.map(step => step.kind)).toEqual(['preview', 'preview', 'preview']);
    const release = gesture.release();
    expect(release).toMatchObject({ kind: 'commit', itemId: '甲', volume: 50 });
    // The change event after pointerup does not save it again.
    expect(gesture.release()).toEqual({ kind: 'none' });
    if (release.kind !== 'commit') throw new Error('松手没有保存');
    const command = setItemVolumeCommand(release.itemId, release.volume, release.gestureId);
    const after = command.execute(before);
    expect(after.rundown[0]?.playback?.volume).toBe(50);
    expect(command.undo(before).rundown[0]?.playback?.volume).toBe(80);
  });

  it('键盘每按一次就保存，同一次聚焦里连按算一步撤销；拖动和之后的按键各算一步', () => {
    const gesture = new SongVolumeGesture();
    gesture.focus();
    const keys = [81, 82].map(volume => gesture.input('甲', volume));
    expect(keys.map(step => step.kind)).toEqual(['commit', 'commit']);
    const groups = keys.map(step => step.kind === 'commit' ? setItemVolumeCommand(step.itemId, step.volume, step.gestureId).historyGroup : null);
    expect(groups[0]).toBeTruthy();
    expect(groups[1]).toBe(groups[0]);
    gesture.press('甲'); gesture.input('甲', 30);
    const drag = gesture.release(), next = gesture.input('甲', 31);
    const group = (step: typeof drag) => step.kind === 'commit' ? setItemVolumeCommand(step.itemId, step.volume, step.gestureId).historyGroup : null;
    expect(new Set([groups[0], group(drag), group(next)]).size).toBe(3);
    gesture.focus();
    expect(group(gesture.input('甲', 32))).not.toBe(group(next));
  });
});

describe('第一次设音量不改 MTC 起始码', () => {
  it('没有播放设置的歌第一次设音量，MTC 起始码还是它原来播放时用的', () => {
    const value = project();
    const imported = { ...song('丙', undefined), p1Media: { sourceKey: 'b'.repeat(64), playlistId: 'p1-list', sourceFileName: '丙.wav', playEndAction: 'stop' as const,
      volume: 100, muted: false, shortcut: '', midiStartTime: '600' } };
    const opened = parseLinkProject({ ...value, rundown: [...value.rundown, imported], p1Sync: { format: 'hirender-p1-audio-project',
      sourceSha256: 'c'.repeat(64), importedAt: '2026-11-09T00:00:00.000Z', playlists: [{ id: 'p1-list', name: 'P1', sourceIndex: 0 }] } });
    const item = opened.rundown[2]!;
    expect(item.playback).toBeUndefined();
    const start = programTimeOrigin(item);
    expect(start).toBe(600_000);
    expect(defaultItemPlayback(item)).toMatchObject({ volume: 100, mtcOffsetMs: start });
    const after = setItemVolumeCommand('丙', 55, 'g').execute(opened).rundown[2]!;
    expect(after.playback).toMatchObject({ volume: 55, mtcOffsetMs: start, startMs: 0, endMs: 0 });
    expect(programTimeOrigin(after)).toBe(start);
  });
});

describe('播放中保存的音量一变，输出跟着变', () => {
  it('没有 MIDI 临时音量时，保存的音量立刻生效；暂停、继续、定位后也不弹回旧值', async () => {
    const f = program(project());
    await f.player.play('甲');
    expect(await f.gain()).toBe(80);
    f.player.setSongVolume('甲', 30);
    expect(await f.gain()).toBe(30);
    await f.player.pause(); await f.player.resume();
    expect(await f.gain()).toBe(30);
    await f.player.seek(2_000); await f.player.resume();
    expect(await f.gain()).toBe(30);
    // Faded out and paused, it plays on at its own volume.
    f.player.fade(true);
    expect(await f.gain()).toBe(0);
    await f.player.pause(); await f.player.resume();
    expect(await f.gain()).toBe(30);
    // Another song's saved volume changed while this one plays: this one is untouched, that one starts at it.
    f.player.setSongVolume('乙', 65);
    expect(await f.gain()).toBe(30);
    await f.player.play('乙');
    // It starts at that volume, not at the one the program opened with and then corrected.
    expect(f.api.prepareNativePlayback.mock.calls.at(-1)?.[0].snapshot.volume).toBe(0.65);
    expect(await f.gain()).toBe(65);
    await f.player.dispose();
  });

  it('拖动中的试听不被覆盖；松手保存以后输出等于保存的值', async () => {
    const f = program(project());
    await f.player.play('甲');
    f.player.previewVolume(55);
    expect(await f.gain()).toBe(55);
    f.player.setSongVolume('甲', 55);
    expect(await f.gain()).toBe(55);
    expect(f.state().volume).toBe(55);
    await f.player.dispose();
  });
});

describe('MIDI CC7 是这一遍的临时音量', () => {
  it('CC7 不改工程，也不进撤销；保存的音量变了也不顶掉它', async () => {
    const opened = project(), saved = structuredClone(opened);
    const f = program(opened);
    await f.player.play('甲');
    f.player.receiveMidi(Uint8Array.from([0xb0, 7, 127]));
    expect(await f.gain()).toBe(100);
    expect(f.state().volumeOverride).toBe(100);
    expect(opened).toEqual(saved);
    f.player.setSongVolume('甲', 20);
    expect(await f.gain()).toBe(100);
    await f.player.dispose();
  });

  it('换歌或停止后清掉，回到这首歌保存的音量；同一首重播保留', async () => {
    const f = program(project());
    await f.player.play('甲');
    f.player.receiveMidi(Uint8Array.from([0xb0, 7, 0]));
    expect(await f.gain()).toBe(0);
    await f.player.play('甲');
    expect(f.state().volumeOverride).toBe(0);
    await f.player.play('乙');
    expect(f.state().volumeOverride).toBeNull();
    expect(await f.gain()).toBe(40);
    f.player.receiveMidi(Uint8Array.from([0xb0, 7, 127]));
    await f.player.stop();
    expect(f.state().volumeOverride).toBeNull();
    await f.player.play('乙');
    expect(await f.gain()).toBe(40);
    await f.player.dispose();
  });
});
