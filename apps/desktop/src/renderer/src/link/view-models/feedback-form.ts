import { FEEDBACK_LIMITS, feedbackCategoryLabels, linkFeedbackDraftSchema, type FeedbackCategory, type LinkFeedbackDraft, type LinkFeedbackResult } from '@tb/schema';

export const FEEDBACK_CATEGORIES = Object.entries(feedbackCategoryLabels) as [FeedbackCategory, string][];
export type OccurredPreset = 'now' | '5m' | '30m' | 'custom';
export const OCCURRED_PRESETS: [OccurredPreset, string][] = [['now', '刚刚'], ['5m', '约 5 分钟前'], ['30m', '约 30 分钟前'], ['custom', '选择时间']];

export type FeedbackFormValues = {
  category: FeedbackCategory | '';
  description: string;
  contact: string;
  occurred: OccurredPreset;
  /** `datetime-local` value, local time, used when `occurred` is 'custom'. */
  occurredAt: string;
  includeDiagnostics: boolean;
  includeMa2: boolean;
};

/** When the problem happened, as an instant; a custom time later than now is refused. */
export function occurredInstant(values: Pick<FeedbackFormValues, 'occurred' | 'occurredAt'>, now: number): string {
  if (values.occurred === 'custom') {
    const at = new Date(values.occurredAt).getTime();
    if (!values.occurredAt || !Number.isFinite(at)) throw new Error('请选择问题发生的时间');
    if (at > now + 60_000) throw new Error('发生时间不能晚于现在');
    if (now - at > 30 * 24 * 3_600_000) throw new Error('只能反馈 30 天内发生的问题，更早的日志已不保留');
    return new Date(at).toISOString();
  }
  const minutes = values.occurred === '5m' ? 5 : values.occurred === '30m' ? 30 : 0;
  return new Date(now - minutes * 60_000).toISOString();
}

/** The form as the main process takes it; throws with the first problem to fix. */
export function feedbackDraft(values: FeedbackFormValues, context: Record<string, unknown>, now: number): LinkFeedbackDraft {
  if (!values.category) throw new Error('请选择问题类型');
  const parsed = linkFeedbackDraftSchema.safeParse({ category: values.category, description: values.description, contact: values.contact,
    occurredAt: occurredInstant(values, now), includeDiagnostics: values.includeDiagnostics, includeMa2: values.includeDiagnostics && values.includeMa2, context });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '反馈内容无效');
  return parsed.data;
}

/** `datetime-local` value for an instant, in this computer's time zone. */
export function localDateTimeValue(at: number): string {
  const date = new Date(at); const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function descriptionCount(text: string): string {
  return `${text.trim().length} / ${FEEDBACK_LIMITS.descriptionMax}`;
}

/** What the operator reads after sending: the number to quote, then what became of the diagnostic package. */
export function submittedMessage(result: Extract<LinkFeedbackResult, { outcome: 'submitted' }>): { tone: 'success' | 'warning'; text: string } {
  const head = `已提交，反馈编号 ${result.number}。联系售后时报这个编号即可。`;
  if (result.attachment === 'uploaded') return { tone: 'success', text: `${head}诊断包已一并上传。` };
  if (result.attachment === 'none') return { tone: 'success', text: `${head}这次没有附带诊断包。` };
  return { tone: 'warning', text: `${head}${result.attachmentIssue ?? '诊断包没有上传，请用「另存为文件」导出后发给售后。'}` };
}
