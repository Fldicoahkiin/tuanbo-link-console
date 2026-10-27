import { expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { p1ImportReport, withP1MtcStart } from './p1-import-report';

const audio = (id: string, durationMs = 90_000) => ({ assetId: id, relativePath: `assets/${id}.wav`, sha256: 'a'.repeat(64), durationMs });
const KEYS = { imkun: '1'.repeat(64), daoma: '2'.repeat(64) };
const p1Media = (key: keyof typeof KEYS, midiStartTime: string) => ({ sourceKey: KEYS[key], playlistId: 'p1-playlist-1', sourceFileName: `${key}.mp4`, playEndAction: 'stop', volume: 100, muted: false, shortcut: '', midiStartTime });
const playback = (mtcOffsetMs: number) => ({ volume: 100, startMs: 0, endMs: 0, mtcOffsetMs, shortcut: '' });

function fixture() {
  return parseLinkProject({ ...createEmptyLinkProject('P1 导入结果'),
    p1Sync: { format: 'hirender-p1-audio-project', sourceSha256: 'b'.repeat(64), importedAt: '2026-10-27T00:00:00.000Z', playlists: [{ id: 'p1-playlist-1', name: '演出歌单', sourceIndex: 0 }] },
    rundown: [
    { id: 'p1-imkun', title: 'imkun.mp4', cues: [], referenceAudio: audio('p1-imkun'), p1Media: p1Media('imkun', '2400'), playback: playback(2_400_000) },
    { id: 'p1-daoma', title: '刀马.mp4', cues: [], referenceAudio: audio('p1-daoma'), p1Media: p1Media('daoma', '600'), playback: playback(600_000) },
    { id: 'local-imkun', title: 'IMKUN', cues: [], referenceAudio: audio('local-imkun', 91_000), playback: playback(14_215_000) },
    { id: 'local-daoma', title: '刀马', cues: [], referenceAudio: audio('local-daoma'), playback: playback(600_000) },
    { id: 'local-new', title: '新歌', cues: [], referenceAudio: audio('local-new') }
  ] });
}

it('列出这次从 P1 读到的每首歌和它的 MTC 起始码', () => {
  const report = p1ImportReport(fixture(), [KEYS.imkun, KEYS.daoma]);
  expect(report.songs.map(song => [song.title, song.start])).toEqual([['imkun.mp4', { state: 'set', startMs: 2_400_000 }], ['刀马.mp4', { state: 'set', startMs: 600_000 }]]);
});

it('本地歌和 P1 的歌同名但起始码不同时指出来；起始码一样或名字对不上一首的不提', () => {
  const report = p1ImportReport(fixture(), [KEYS.imkun, KEYS.daoma]);
  expect(report.sameName).toEqual([{ localId: 'local-imkun', localTitle: 'IMKUN', localStart: { state: 'set', startMs: 14_215_000 }, lit: false,
    p1Id: 'p1-imkun', p1Title: 'imkun.mp4', p1StartMs: 2_400_000, durationDifferenceMs: 1000 }]);
  const project = fixture();
  project.rundown.push({ ...structuredClone(project.rundown[2]!), id: 'local-imkun-2' });
  expect(p1ImportReport(project, [KEYS.imkun, KEYS.daoma]).sameName).toEqual([]);
});

it('改成 P1 的起始码只换起点，保留音量和裁剪', () => {
  const local = { ...fixture().rundown[2]!, playback: { volume: 70, startMs: 1000, endMs: 0, mtcOffsetMs: 14_215_000, shortcut: 'F1' } };
  expect(withP1MtcStart(local, 2_400_000)).toEqual({ volume: 70, startMs: 1000, endMs: 0, mtcOffsetMs: 2_400_000, shortcut: 'F1' });
});
