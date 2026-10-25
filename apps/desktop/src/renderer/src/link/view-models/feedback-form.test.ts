import { describe, expect, it } from 'vitest';
import { feedbackDraft, localDateTimeValue, occurredInstant, submittedMessage, type FeedbackFormValues } from './feedback-form';

const now = Date.parse('2026-10-25T12:00:00.000Z');
const values: FeedbackFormValues = { category: 'playback', description: '第 3 首播放到一半没有声音', contact: '', occurred: 'now', occurredAt: '',
  includeDiagnostics: true, includeMa2: true };

describe('feedback form', () => {
  it('发生时间按预设往前推，自选时间不能晚于现在或早于 30 天', () => {
    expect(occurredInstant({ occurred: 'now', occurredAt: '' }, now)).toBe('2026-10-25T12:00:00.000Z');
    expect(occurredInstant({ occurred: '30m', occurredAt: '' }, now)).toBe('2026-10-25T11:30:00.000Z');
    const custom = localDateTimeValue(now - 3_600_000);
    expect(occurredInstant({ occurred: 'custom', occurredAt: custom }, now)).toBe(new Date(now - 3_600_000).toISOString());
    expect(() => occurredInstant({ occurred: 'custom', occurredAt: '' }, now)).toThrow('请选择问题发生的时间');
    expect(() => occurredInstant({ occurred: 'custom', occurredAt: localDateTimeValue(now + 3_600_000) }, now)).toThrow('不能晚于现在');
    expect(() => occurredInstant({ occurred: 'custom', occurredAt: localDateTimeValue(now - 31 * 24 * 3_600_000) }, now)).toThrow('30 天内');
  });

  it('要求选类型、写够字；不附诊断包时也不附 MA2 数据', () => {
    expect(() => feedbackDraft({ ...values, category: '' }, {}, now)).toThrow('请选择问题类型');
    expect(() => feedbackDraft({ ...values, description: ' 没声 ' }, {}, now)).toThrow('请至少写 5 个字');
    expect(feedbackDraft({ ...values, includeDiagnostics: false }, { project: null }, now)).toMatchObject({ includeDiagnostics: false, includeMa2: false, context: { project: null } });
    expect(feedbackDraft(values, {}, now)).toMatchObject({ category: 'playback', description: '第 3 首播放到一半没有声音', includeMa2: true });
  });

  it('提交结果先给编号，诊断包没上传时说明原因', () => {
    expect(submittedMessage({ outcome: 'submitted', number: 'FB-20261025-7K3Q', attachment: 'uploaded', attachmentIssue: null }))
      .toEqual({ tone: 'success', text: '已提交，反馈编号 FB-20261025-7K3Q。联系售后时报这个编号即可。诊断包已一并上传。' });
    expect(submittedMessage({ outcome: 'submitted', number: 'FB-20261025-7K3Q', attachment: 'refused', attachmentIssue: '服务器诊断包空间已满' }))
      .toEqual({ tone: 'warning', text: '已提交，反馈编号 FB-20261025-7K3Q。联系售后时报这个编号即可。服务器诊断包空间已满' });
  });
});
