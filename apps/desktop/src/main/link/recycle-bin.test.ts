import { describe, expect, it, vi } from 'vitest';
import { recycleBin } from './recycle-bin';

describe('recycleBin', () => {
  it('Windows 上先确认回收站在本会话可用，再交给回收站；同一盘只确认一次', async () => {
    const trash = vi.fn(() => Promise.resolve()), recycles = vi.fn(() => Promise.resolve(true));
    const move = recycleBin(trash, { platform: 'win32', recycles });
    await move('C:\\logs\\old.jsonl'); await move('C:\\logs\\older.jsonl');
    expect(recycles).toHaveBeenCalledOnce(); expect(recycles).toHaveBeenCalledWith('C:\\logs');
    expect(trash.mock.calls).toEqual([['C:\\logs\\old.jsonl'], ['C:\\logs\\older.jsonl']]);
  });

  it('回收站在本会话不可用（SSH、服务里 Windows 会直接永久删除）时报错且不动文件', async () => {
    const trash = vi.fn(() => Promise.resolve());
    const move = recycleBin(trash, { platform: 'win32', recycles: () => Promise.resolve(false) });
    await expect(move('C:\\logs\\old.jsonl')).rejects.toThrow('回收站在当前会话不可用，未删除：C:\\logs\\old.jsonl');
    expect(trash).not.toHaveBeenCalled();
  });

  it('回收站拒绝时（例如网络路径）原样报错', async () => {
    const trash = vi.fn(() => Promise.reject(new Error('Failed to perform delete operation')));
    const move = recycleBin(trash, { platform: 'win32', recycles: () => Promise.resolve(true) });
    await expect(move('D:\\show\\old.jsonl')).rejects.toThrow('Failed to perform delete operation');
  });

  it('macOS 开发环境直接使用废纸篓', async () => {
    const trash = vi.fn(() => Promise.resolve()), recycles = vi.fn(() => Promise.resolve(false));
    await recycleBin(trash, { platform: 'darwin', recycles })('/tmp/old.jsonl');
    expect(trash).toHaveBeenCalledOnce(); expect(recycles).not.toHaveBeenCalled();
  });
});
