import { describe, expect, it } from 'vitest';
import { driftedDecoders, isHandSwitch, materialPositionMs, nextPictureFollow, PICTURE_FOLLOW_START, pictureFollowVerdict, type PictureFollowTarget,
  type PictureReading } from './picture-follow';

const target = (patch: Partial<PictureFollowTarget> = {}): PictureFollowTarget => ({ programScene: '全景', programWait: null, takenOver: null,
  decoders: [{ sourceName: '素材甲', assetName: '开场', mode: 'playing' }], ...patch });
const reading = (patch: Partial<Extract<PictureReading, { kind: 'read' }>> = {}): PictureReading => ({ kind: 'read', programScene: '全景', transitioning: false,
  decoders: [{ sourceName: '素材甲', state: 'playing', driftMs: 40 }], music: { kind: 'carried' }, ...patch });

describe('画面在不在跟（R8，写法照“控台在不在跟”）', () => {
  it('场景和素材都对：在跟，说出在播哪个场景、几段素材', () => {
    expect(pictureFollowVerdict(target(), reading())).toEqual({ kind: 'judged', following: true, detail: 'OBS 在播「全景」，和时间线一致，1 段素材跟着音乐' });
  });

  it('场景不对、素材没在播、差了 300 ms 以上：都算对不上，一句一句说清楚', () => {
    expect(pictureFollowVerdict(target(), reading({ programScene: '特写' }))).toMatchObject({ following: false, detail: 'OBS 现在播的是「特写」，按时间线这时应该是「全景」' });
    expect(pictureFollowVerdict(target(), reading({ decoders: [{ sourceName: '素材甲', state: 'stopped', driftMs: null }] })))
      .toMatchObject({ following: false, detail: '素材“开场”在 OBS 里已经停止，按时间线这时应该在播' });
    expect(pictureFollowVerdict(target(), reading({ decoders: [] }))).toMatchObject({ following: false, detail: '素材“开场”在 OBS 里不在画面上，按时间线这时应该在播' });
    expect(pictureFollowVerdict(target(), reading({ decoders: [{ sourceName: '素材甲', state: 'playing', driftMs: -300 }] })))
      .toMatchObject({ following: false, detail: '素材“开场”和音乐差了 300 ms' });
    expect(pictureFollowVerdict(target(), reading({ decoders: [{ sourceName: '素材甲', state: 'playing', driftMs: 299 }] }))).toMatchObject({ following: true });
  });

  it('暂停着的素材停着才对：音乐暂停时素材停着算在跟', () => {
    const paused = target({ decoders: [{ sourceName: '素材甲', assetName: '开场', mode: 'paused' }] });
    expect(pictureFollowVerdict(paused, reading({ decoders: [{ sourceName: '素材甲', state: 'paused', driftMs: null }] }))).toMatchObject({ following: true });
    expect(pictureFollowVerdict(paused, reading())).toMatchObject({ following: false, detail: '素材“开场”还在播，音乐停着它应该暂停' });
  });

  it('读不到就是“无法确认”和原因，从不算在跟；场景里有没有音乐查不到也是无法确认', () => {
    expect(pictureFollowVerdict(target(), { kind: 'unreadable', reason: '请求超时' })).toEqual({ kind: 'unknown', reason: '读不到 OBS 现在的画面：请求超时' });
    expect(pictureFollowVerdict(target(), reading({ music: { kind: 'unknown', reason: 'OBS 拒绝了' } })))
      .toEqual({ kind: 'unknown', reason: '无法确认「全景」里有没有联动台的音乐：OBS 拒绝了' });
    expect(nextPictureFollow({ state: 'following', detail: '在跟', misses: 0 }, { kind: 'unknown', reason: '读不到' })).toEqual({ state: 'unknown', detail: '读不到', misses: 0 });
  });

  it('转场中不判；被手动接管时不看场景（素材照常对）；刚切完没东西可比时等着', () => {
    expect(pictureFollowVerdict(target(), reading({ programScene: '特写', transitioning: true }))).toEqual({ kind: 'wait', reason: 'OBS 正在转场，转场完了再核对' });
    expect(pictureFollowVerdict(target({ takenOver: '手动' }), reading({ programScene: '手动' })))
      .toEqual({ kind: 'taken-over', detail: '有人在 OBS 里切到了「手动」，联动台不切回去；到下一段画面按时间线照常切换' });
    expect(pictureFollowVerdict(target({ programScene: null, programWait: '刚切过画面，稍后核对', decoders: [] }), reading({ programScene: '特写' })))
      .toEqual({ kind: 'wait', reason: '刚切过画面，稍后核对' });
  });

  it('连续 2 次对不上才算没在跟；一次对上就回到在跟；等待不改已有的结论', () => {
    const miss = { kind: 'judged', following: false, detail: '对不上' } as const;
    const once = nextPictureFollow(PICTURE_FOLLOW_START, miss);
    expect(once).toEqual({ ...PICTURE_FOLLOW_START, misses: 1 });
    expect(nextPictureFollow(once, miss)).toEqual({ state: 'not-following', detail: '对不上', misses: 2 });
    const following = nextPictureFollow(once, { kind: 'judged', following: true, detail: '在跟' });
    expect(following).toEqual({ state: 'following', detail: '在跟', misses: 0 });
    expect(nextPictureFollow(following, miss)).toEqual({ state: 'following', detail: '在跟', misses: 1 });
    expect(nextPictureFollow(following, { kind: 'wait', reason: '转场' })).toBe(following);
    expect(nextPictureFollow({ state: 'unknown', detail: '读不到', misses: 0 }, { kind: 'wait', reason: '转场' })).toEqual({ state: 'checking', detail: '转场', misses: 0 });
    // A takeover that ended (our switch at the next segment went out) does not stay yellow while the switch settles.
    expect(nextPictureFollow({ state: 'taken-over', detail: '手动', misses: 0 }, { kind: 'wait', reason: '刚切过' })).toEqual({ state: 'checking', detail: '刚切过', misses: 0 });
    expect(nextPictureFollow(PICTURE_FOLLOW_START, { kind: 'wait', reason: '刚切过' })).toEqual({ state: 'checking', detail: '刚切过', misses: 0 });
  });

  it('手动切换：既不是时间线要的，也不是联动台刚切的；时间线这时不切画面就不算', () => {
    expect(isHandSwitch('手动', '全景', '全景')).toBe(true);
    expect(isHandSwitch('全景', '全景', '特写')).toBe(false);
    expect(isHandSwitch('特写', '全景', '特写')).toBe(false);
    expect(isHandSwitch('手动', null, null)).toBe(false);
  });

  it('素材该在的位置和漂移：音乐过了片段开头多久就往后多少', () => {
    expect(materialPositionMs(5000, 1000, 3500)).toBe(7500);
    expect(materialPositionMs(5000, 1000, 500)).toBe(5000);
    expect(driftedDecoders(target(), reading({ decoders: [{ sourceName: '素材甲', state: 'playing', driftMs: 450.4 }] }))).toEqual([{ sourceName: '素材甲', driftMs: 450 }]);
    expect(driftedDecoders(target(), reading())).toEqual([]);
  });
});
