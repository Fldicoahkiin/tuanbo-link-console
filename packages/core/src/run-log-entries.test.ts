import { describe, expect, it } from 'vitest';
import type { PreflightCheck } from './link-preflight';
import { firstTimeWarning, preflightLogEntries } from './run-log-entries';

const passed = (id: string, label: string): PreflightCheck => ({ id, label, status: 'passed', detail: '通过' });

describe('preflightLogEntries', () => {
  it('全部通过时只有一条汇总，各项结果放进详情', () => {
    const checks = [passed('disk', '可用磁盘空间'), passed('obs.version', 'OBS 版本'), passed('redaction', '日志脱敏')];
    const entries = preflightLogEntries(checks, new Set(), 'project');
    expect(entries).toEqual([{ level: 'info', message: '开播前检查通过（3 项）', result: 'succeeded',
      details: { checks: checks.map(({ id, label, status, detail }) => ({ id, label, status, detail })) } }]);
  });

  it('阻断项每次单独记为错误；提示项同一工程本次运行只记一次', () => {
    const seen = new Set<string>();
    const checks: PreflightCheck[] = [passed('disk', '可用磁盘空间'),
      { id: 'quality.upscale.clip', label: '素材清晰度：1.MP4', status: 'warning', detail: '原始 720×1280，放大到约 1080×1920' },
      { id: 'asset.media.clip', label: '时间线素材：2.MP4', status: 'blocking', detail: '素材文件缺失或不可读' }];
    const first = preflightLogEntries(checks, seen, 'project');
    expect(first.map(entry => [entry.level, entry.message])).toEqual([
      ['error', '开播前检查未通过（1 项阻断，1 项提示，共 3 项）'],
      ['error', '时间线素材：2.MP4：素材文件缺失或不可读'],
      ['info', '开播前检查提示：素材清晰度：1.MP4：原始 720×1280，放大到约 1080×1920']]);
    const again = preflightLogEntries(checks, seen, 'project');
    expect(again.map(entry => entry.message)).toEqual(['开播前检查未通过（1 项阻断，1 项提示，共 3 项）', '时间线素材：2.MP4：素材文件缺失或不可读']);
    // A changed asset (new size) or another project is noted again.
    const changed = checks.map(check => check.status === 'warning' ? { ...check, detail: '原始 1080×1920，放大到约 1440×2560' } : check);
    expect(preflightLogEntries(changed, seen, 'project').some(entry => entry.message.startsWith('开播前检查提示'))).toBe(true);
    expect(preflightLogEntries(checks, seen, 'other').some(entry => entry.message.startsWith('开播前检查提示'))).toBe(true);
  });

  it('只有提示项时汇总仍是信息级别', () => {
    const entries = preflightLogEntries([passed('disk', '可用磁盘空间'), { id: 'quality.outputScale', label: 'OBS 输出像素', status: 'warning', detail: 'OBS 正在缩放' }], new Set(), 'project');
    expect(entries.map(entry => [entry.level, entry.message])).toEqual([['info', '开播前检查通过（2 项，1 项提示）'], ['info', '开播前检查提示：OBS 输出像素：OBS 正在缩放']]);
  });
});

describe('firstTimeWarning', () => {
  it('同一件需要人处理的事本次运行只在第一次记警告，之后记信息', () => {
    const seen = new Set<string>();
    expect(firstTimeWarning(seen, 'Timecode 9907 需要重新核对')).toBe('warning');
    expect(firstTimeWarning(seen, 'Timecode 9907 需要重新核对')).toBe('info');
    expect(firstTimeWarning(seen, '音频已替换')).toBe('warning');
  });
});
