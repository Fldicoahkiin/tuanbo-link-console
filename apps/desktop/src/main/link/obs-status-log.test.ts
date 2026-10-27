import { describe, expect, it } from 'vitest';
import { obsStatusLogEntry } from './obs-status-log';

const snapshot = (status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error', error: string | null = null) =>
  ({ status, obsVersion: status === 'connected' ? '32.0.1' : null, webSocketVersion: status === 'connected' ? '5.6.3' : null, error });

describe('obsStatusLogEntry', () => {
  it('只记连上、掉线和连接错误；连接中和连接失败（由连接动作自己记录）不记', () => {
    expect(obsStatusLogEntry('disconnected', snapshot('connecting'))).toBeNull();
    expect(obsStatusLogEntry('connecting', snapshot('connected'))).toEqual({ level: 'info', message: 'OBS 已连接（OBS 32.0.1）', result: 'succeeded',
      details: { obsVersion: '32.0.1', webSocketVersion: '5.6.3' } });
    expect(obsStatusLogEntry('connecting', snapshot('error', '认证失败'))).toBeNull();
    expect(obsStatusLogEntry('connected', snapshot('connected'))).toBeNull();
  });

  it('连接中途掉线是需要人处理的警告；连接错误记为错误；操作员断开只是信息', () => {
    expect(obsStatusLogEntry('connected', snapshot('disconnected', 'socket hang up'))).toEqual({ level: 'warning', message: 'OBS 连接已断开：socket hang up', result: 'failed', details: { error: 'socket hang up' } });
    expect(obsStatusLogEntry('connected', snapshot('error', 'ECONNRESET'))).toEqual({ level: 'error', message: 'OBS 连接出错：ECONNRESET', result: 'failed', details: { error: 'ECONNRESET' } });
    expect(obsStatusLogEntry('connected', snapshot('disconnected'))).toEqual({ level: 'info', message: 'OBS 已断开连接', result: 'succeeded' });
    expect(obsStatusLogEntry('connected', snapshot('reconnecting'))).toBeNull();
  });
});
