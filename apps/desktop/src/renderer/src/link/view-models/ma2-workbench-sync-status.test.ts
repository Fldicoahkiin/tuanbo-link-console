import { describe, expect, it } from 'vitest';
import { ma2WorkbenchSyncStatus } from './ma2-workbench-sync-status';

type Input = Parameters<typeof ma2WorkbenchSyncStatus>[0];
const ready: Input = {
  targetCount: 1, songs: [{ state: 'verified' }], names: 'idle', session: { status: 'ready', message: '' },
  localCount: 0, manual: false, recoveryError: null, reading: false
};
const status = (change: Partial<Input>) => ma2WorkbenchSyncStatus({ ...ready, ...change });

describe('左下角只显示正在同步和已同步', () => {
  it('已确认的歌曲在例行核对和播放期间保持已同步', () => {
    const polling = { state: 'verified' as const, checking: true, requestId: 'read', checkedAt: 100 };
    expect(status({ songs: [polling] }).label).toBe('已同步');
    expect(status({ session: { status: 'waiting', waitFor: 'show', message: '' } }).label).toBe('已同步');
  });
  it('首次读取、队列和真实写入都显示正在同步，直到每首歌已确认', () => {
    expect(status({ reading: true }).label).toBe('正在同步');
    expect(status({ songs: [], targetCount: 50 }).label).toBe('正在同步');
    expect(status({ targetCount: 50 }).label).toBe('正在同步');
    expect(status({ localCount: 1 }).label).toBe('正在同步');
    expect(status({ songs: [{ state: 'syncing', writing: true }] }).label).toBe('正在同步');
    expect(status({ names: 'pending' }).label).toBe('正在同步');
    expect(status({ songs: Array.from({ length: 50 }, () => ({ state: 'verified' })), targetCount: 50 }).label).toBe('已同步');
  });
  it('真正停下的任务保留详情入口，既不持续读条也不提前确认', () => {
    expect(status({ session: { status: 'waiting', waitFor: 'connection', message: '' } }).label).toBeNull();
    expect(status({ session: { status: 'waiting', waitFor: 'show', message: '' }, localCount: 1 }).label).toBeNull();
    expect(status({ songs: [{ state: 'pending', recheckRevision: 0 }] }).label).toBeNull();
    expect(status({ songs: [], manual: true, localCount: 1 }).label).toBeNull();
    expect(status({ songs: [], targetCount: 0 }).label).toBeNull();
    expect(status({ names: 'blocked' })).toEqual({ label: null, tone: 'idle' });
    expect(status({ session: { status: 'blocked', message: '无法确认控台' } }).label).toBeNull();
  });
  it('一首歌停下时其他歌可以继续；操作结束后保留真实结果', () => {
    expect(status({ songs: [{ state: 'blocked' }, { state: 'pending' }] }).label).toBe('正在同步');
    expect(status({ songs: [{ state: 'blocked' }, { state: 'verified' }] }).label).toBeNull();
    expect(status({ songs: [{ state: 'verified' }, { state: 'verified' }] }).label).toBe('已同步');
  });
});
