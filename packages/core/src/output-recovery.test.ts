import { describe, expect, it } from 'vitest';
import { OBS_RECONNECT_DELAYS_MS, OUTPUT_RECOVERY_RULES, OutputRecovery, ma2ReloginDelayMs, obsReconnectDelayMs, pictureRepairAllowed, recordPictureRepair, type RecoveryRow } from './output-recovery';

const outcomes = (recovery: OutputRecovery, row: RecoveryRow, times: number[], key = 'k'): string[] =>
  times.map(time => recovery.record(row, key, time).outcome);

describe('自动恢复都有次数上限，全软件只有这一张表（2026-11-10 第 2 题，2026-11-11 定的数字）', () => {
  it('表里的数字就是 2026-11-11 定下的那组', () => {
    expect(OUTPUT_RECOVERY_RULES['picture.element'].limit).toEqual({ kind: 'count', max: 1 });
    expect(OUTPUT_RECOVERY_RULES['picture.song'].limit).toEqual({ kind: 'count', max: 20 });
    expect(OUTPUT_RECOVERY_RULES['obs.reconnect'].limit).toEqual({ kind: 'count', max: 10 });
    expect(OUTPUT_RECOVERY_RULES['ma2.relogin'].limit).toEqual({ kind: 'duration', maxMs: 300_000 });
    expect(OUTPUT_RECOVERY_RULES['ma2.webRemote.relogin'].limit).toEqual(OUTPUT_RECOVERY_RULES['ma2.relogin'].limit);
    expect(OUTPUT_RECOVERY_RULES['audio.underrun'].limit).toEqual({ kind: 'window', max: 5, windowMs: 60_000 });
    expect(OUTPUT_RECOVERY_RULES['audio.underrun'].atLimit).toBe('stop-song');
    expect(OUTPUT_RECOVERY_RULES['mtc.sendFailure'].limit).toEqual({ kind: 'count', max: 3 });
    expect(OUTPUT_RECOVERY_RULES['mtc.sendFailure'].atLimit).toBe('stop-timecode-for-song');
    expect(OUTPUT_RECOVERY_RULES['lighting.offResend'].limit).toEqual({ kind: 'count', max: 1 });
    expect(OUTPUT_RECOVERY_RULES['actionMidi.stuckSysex'].limit).toEqual({ kind: 'count', max: 3 });
    expect(OUTPUT_RECOVERY_RULES['actionMidi.stuckSysex'].atLimit).toBe('stop-channel');
  });

  it('每一行到上限都有红字：先说发生了什么，再说怎么办', () => {
    for (const rule of Object.values(OUTPUT_RECOVERY_RULES)) expect(rule.limitText).toMatch(/[，。].*(请|会|照常)/);
  });

  it('OBS 重连退避 1、2、4、8 秒以后每次 15 秒，共 10 次，约 2 分钟', () => {
    expect(OBS_RECONNECT_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBe(105_000);
    expect([1, 2, 5, 10, 11, 0].map(obsReconnectDelayMs)).toEqual([1000, 2000, 15_000, 15_000, null, null]);
    const recovery = new OutputRecovery();
    expect(outcomes(recovery, 'obs.reconnect', Array.from({ length: 11 }, (_, index) => index))).toEqual([...Array<string>(10).fill('recover'), 'limit']);
  });

  it('MA2 重新登录退避 1、2、4、8、15 秒以后每次 30 秒；网页遥控一次断线最多 5 分钟（C2）', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20, 0, 1.5].map(ma2ReloginDelayMs)).toEqual([1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000, null, null]);
    const rule = OUTPUT_RECOVERY_RULES['ma2.webRemote.relogin'];
    expect(rule.limit).toEqual({ kind: 'duration', maxMs: 300_000 });
    expect(rule.reset).toBe('outage');
    // Attempt times as the waits give them, from the first attempt at 1 s: every one inside 5 minutes recovers, then the limit.
    const times: number[] = [];
    for (let attempt = 1, at = 0; attempt <= 16; attempt += 1) { at += ma2ReloginDelayMs(attempt)!; times.push(at); }
    const recovery = new OutputRecovery();
    const results = outcomes(recovery, 'ma2.webRemote.relogin', times);
    expect(results.filter(outcome => outcome === 'recover').length).toBe(times.filter(time => time - times[0]! < 300_000).length);
    expect(results.at(-1)).toBe('limit');
    recovery.endOutage('ma2.webRemote.relogin', 'k');
    expect(recovery.allows('ma2.webRemote.relogin', 'k', 10_000_000)).toBe(true);
  });
});

describe('计数、到上限、重置', () => {
  it('画面每个元素在同一个应有状态下补 1 次；换了应有状态重新算；一首歌合计 20 次', () => {
    const recovery = new OutputRecovery();
    expect(pictureRepairAllowed(recovery, 'decoder:M1', 'c1:playing', 0)).toBe(true);
    recordPictureRepair(recovery, 'decoder:M1', 'c1:playing', 0);
    expect(pictureRepairAllowed(recovery, 'decoder:M1', 'c1:playing', 1)).toBe(false);
    expect(pictureRepairAllowed(recovery, 'decoder:M1', 'c2:playing', 1)).toBe(true);
    for (let index = 1; index < 20; index++) recordPictureRepair(recovery, `decoder:M${index + 1}`, 'x', index);
    expect(pictureRepairAllowed(recovery, 'decoder:新的', 'x', 30)).toBe(false);
    const [element, song] = recordPictureRepair(recovery, 'decoder:新的', 'x', 31);
    expect(element!.outcome).toBe('recover');
    expect(song).toMatchObject({ outcome: 'limit', count: 21, limitText: OUTPUT_RECOVERY_RULES['picture.song'].limitText });
  });

  it('声卡 60 秒内断流 5 次停这首歌；隔得开的断流接着走', () => {
    expect(outcomes(new OutputRecovery(), 'audio.underrun', [0, 10_000, 20_000, 30_000, 40_000])).toEqual(['recover', 'recover', 'recover', 'recover', 'limit']);
    expect(outcomes(new OutputRecovery(), 'audio.underrun', [0, 20_000, 40_000, 60_000, 80_000, 100_000])).toEqual(Array(6).fill('recover'));
  });

  it('时间码一首歌失败 3 次以后这首歌不再发，换歌重新算', () => {
    const recovery = new OutputRecovery();
    expect(outcomes(recovery, 'mtc.sendFailure', [0, 100_000, 200_000, 300_000])).toEqual(['recover', 'recover', 'limit', 'limit']);
    recovery.resetSong();
    expect(outcomes(recovery, 'mtc.sendFailure', [400_000])).toEqual(['recover']);
  });

  it('MA2 演出中自动重新登录最多 5 分钟，网页遥控同一上限；重连成功后下次断线重新算', () => {
    const recovery = new OutputRecovery();
    expect(outcomes(recovery, 'ma2.relogin', [0, 60_000, 299_999, 300_000, 310_000], 'console')).toEqual(['recover', 'recover', 'recover', 'limit', 'limit']);
    recovery.endOutage('ma2.relogin', 'console');
    expect(outcomes(recovery, 'ma2.relogin', [400_000], 'console')).toEqual(['recover']);
    expect(outcomes(new OutputRecovery(), 'ma2.webRemote.relogin', [0, 300_000])).toEqual(['recover', 'limit']);
  });

  it('没确认的关灯连上后补发 1 次；换歌不清，确认以后忘掉', () => {
    const recovery = new OutputRecovery();
    expect(outcomes(recovery, 'lighting.offResend', [0, 1], '1.101')).toEqual(['recover', 'limit']);
    recovery.resetSong();
    expect(recovery.allows('lighting.offResend', '1.101', 2)).toBe(false);
    recovery.forget('lighting.offResend', '1.101');
    expect(recovery.allows('lighting.offResend', '1.101', 3)).toBe(true);
  });

  it('到上限以后停在上限，等人处理，不会过一会儿自己又开始', () => {
    const recovery = new OutputRecovery();
    expect(outcomes(recovery, 'picture.drift', [0, 1000])).toEqual(['recover', 'limit']);
    expect(recovery.allows('picture.drift', 'k', 120_000)).toBe(false);
    expect(recovery.counts()).toEqual([{ row: 'picture.drift', key: 'k', count: 2, exhausted: true }]);
  });

  it('换歌只清这首歌的计数，断线重连的计数留着', () => {
    const recovery = new OutputRecovery();
    recovery.record('obs.reconnect', 'obs', 0); recovery.record('obs.restore', 'song', 0);
    recovery.resetSong();
    expect(recovery.counts().map(entry => entry.row)).toEqual(['obs.reconnect']);
  });
});
