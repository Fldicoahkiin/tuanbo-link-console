import { useEffect, useRef, useState } from 'react';
import { Copy, FileText, FolderOpen, Save, Send } from 'lucide-react';
import type { FeedbackCategory } from '@tb/schema';
import { Button, Card, Field, Notice, Select, Switch, TextArea, TextInput } from '../ui';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { descriptionCount, FEEDBACK_CATEGORIES, feedbackDraft, localDateTimeValue, OCCURRED_PRESETS, submittedMessage, type FeedbackFormValues, type OccurredPreset } from '../view-models/feedback-form';

const CONTACT_KEY = 'tblink.feedback.contact.v1';
function rememberedContact(): string {
  try { return window.localStorage.getItem(CONTACT_KEY) ?? ''; }
  catch (error) { console.warn('读取上次填写的联系方式失败', error); return ''; }
}
function rememberContact(value: string): void {
  try { window.localStorage.setItem(CONTACT_KEY, value); }
  catch (error) { console.warn('记住联系方式失败', error); }
}

type Outcome = { tone: 'success' | 'warning' | 'error' | 'info'; text: string; number?: string };

type FeedbackFormProps = {
  /** The window's part of the diagnostic package (see `diagnosticContext`); the activation page has no project to add. */
  context: (includeMa2: boolean) => Record<string, unknown>;
  ma2Available: boolean;
  initialCategory?: FeedbackCategory | '';
  compact?: boolean;
  onOpenLogs?: () => void;
};

/**
 * The problem report: what happened, roughly when, and the diagnostic package. Sent to the feedback server,
 * or saved to a file to send by hand when the venue is offline. Works on an unactivated machine too.
 */
export function FeedbackForm({ context, ma2Available, initialCategory = '', compact = false, onOpenLogs }: FeedbackFormProps): JSX.Element {
  const [values, setValues] = useState<FeedbackFormValues>(() => ({ category: initialCategory, description: '', contact: rememberedContact(), occurred: 'now',
    occurredAt: localDateTimeValue(Date.now()), includeDiagnostics: true, includeMa2: false }));
  const [busy, setBusy] = useState<'submit' | 'save' | 'folder' | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  // The result sits under the buttons; in the activation dialog it can be below the fold.
  useEffect(() => { if (outcome) outcomeRef.current?.scrollIntoView({ block: 'nearest' }); }, [outcome]);
  const set = <K extends keyof FeedbackFormValues>(key: K, value: FeedbackFormValues[K]): void => setValues(current => ({ ...current, [key]: value }));
  const run = async (action: 'submit' | 'save'): Promise<void> => {
    if (busy) return;
    setOutcome(null);
    let draft;
    try { draft = feedbackDraft(values, context(values.includeMa2 && ma2Available), Date.now()); }
    catch (failure) { setOutcome({ tone: 'error', text: failure instanceof Error ? failure.message : String(failure) }); return; }
    setBusy(action);
    rememberContact(draft.contact);
    try {
      if (action === 'submit') {
        const result = await desktop.submitFeedback(draft);
        setOutcome({ ...submittedMessage(result), number: result.number });
        setValues(current => ({ ...current, description: '', occurred: 'now' }));
      } else {
        const result = await desktop.saveFeedback(draft);
        setOutcome(result.outcome === 'saved' ? { tone: 'success', text: `已另存为 ${result.path}。把这个文件发给售后，并说明大概的时间即可。` } : { tone: 'info', text: '已取消保存。' });
      }
    } catch (failure) { setOutcome({ tone: 'error', text: failure instanceof Error ? failure.message : String(failure) }); }
    finally { setBusy(null); }
  };
  const openFolder = async (): Promise<void> => {
    setBusy('folder');
    try { await desktop.openLogsFolder(); }
    catch (failure) { setOutcome({ tone: 'error', text: failure instanceof Error ? failure.message : String(failure) }); }
    finally { setBusy(null); }
  };
  const copyNumber = async (number: string): Promise<void> => {
    try { await navigator.clipboard.writeText(number); setOutcome(current => current ? { ...current, text: `${current.text}（编号已复制）` } : current); }
    catch (failure) { setOutcome({ tone: 'error', text: `复制失败：${failure instanceof Error ? failure.message : String(failure)}` }); }
  };
  const copyTarget = outcome?.number ?? null;
  return <form className={`feedback-form${compact ? ' compact' : ''}`} aria-label="问题反馈" aria-busy={busy !== null} onSubmit={event => { event.preventDefault(); void run('submit'); }}>
    <Card title="看到了什么" description="写清楚做了什么、看到了什么、本来应该怎样。时间越准，越容易在日志里找到原因。">
      <Field label="问题类型">
        {props => <Select {...props} value={values.category} onChange={event => set('category', event.currentTarget.value as FeedbackCategory | '')}>
          <option value="" disabled>请选择</option>
          {FEEDBACK_CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>}
      </Field>
      <Field label="发生时间" help={values.occurred === 'custom' ? '按这台电脑的时间填写' : '大概就行，诊断包会带上前后的日志'}>
        {props => <div className="settings-path-control">
          <Select {...props} aria-label="发生时间" width="auto" value={values.occurred} onChange={event => set('occurred', event.currentTarget.value as OccurredPreset)}>
            {OCCURRED_PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
          {values.occurred === 'custom' ? <TextInput aria-label="选择发生时间" type="datetime-local" width="auto" value={values.occurredAt} max={localDateTimeValue(Date.now())} onChange={event => set('occurredAt', event.currentTarget.value)} /> : null}
        </div>}
      </Field>
      <Field label="现象说明" stacked help={descriptionCount(values.description)}>
        {props => <TextArea {...props} rows={compact ? 4 : 5} maxLength={2000} value={values.description} onChange={event => set('description', event.currentTarget.value)}
          placeholder="例如：播放第 3 首「夜曲」到副歌时灯光没跟上，OBS 画面正常；停止后重新播放能复现" />}
      </Field>
      <Field label="联系方式" help="选填。手机号或微信，方便售后回访；会记在这台电脑上，下次自动填好">
        {props => <TextInput {...props} value={values.contact} maxLength={100} autoComplete="off" onChange={event => set('contact', event.currentTarget.value)} />}
      </Field>
    </Card>
    <Card title="附带的信息">
      <Switch label="附带诊断包" checked={values.includeDiagnostics} onChange={event => set('includeDiagnostics', event.currentTarget.checked)}
        help="软件版本、电脑与连接状态，以及问题发生前后的运行日志。密码会隐藏，不含音视频素材" />
      {values.includeDiagnostics && (ma2Available || !compact) ? <Switch label="附带 MA2 原始数据" checked={values.includeMa2 && ma2Available} disabled={!ma2Available} onChange={event => set('includeMa2', event.currentTarget.checked)}
        help={ma2Available ? '当前工程已读取的控台数据，排查 Cue、配对和转换问题时有用' : '当前工程还没有从控台读取过数据'} /> : null}
    </Card>
    <div className="settings-actions-row">
      <Button type="submit" variant="primary" icon={Send} loading={busy === 'submit'} disabled={busy !== null}>提交反馈</Button>
      <Button type="button" variant="secondary" icon={Save} loading={busy === 'save'} disabled={busy !== null} onClick={() => void run('save')}>另存为文件</Button>
      {!compact ? <Button type="button" variant="secondary" icon={FolderOpen} disabled={busy !== null} onClick={() => void openFolder()}>打开日志文件夹</Button> : null}
      {onOpenLogs ? <Button type="button" variant="ghost" icon={FileText} disabled={busy !== null} onClick={onOpenLogs}>查看运行日志</Button> : null}
    </div>
    <div ref={outcomeRef}>{outcome ? <Notice tone={outcome.tone} actions={copyTarget ? <Button type="button" variant="secondary" size="sm" icon={Copy} className="feedback-copy" onClick={() => void copyNumber(copyTarget)}>复制编号</Button> : undefined}>
      <span className="feedback-outcome">{outcome.text}</span>
    </Notice> : null}</div>
    <p className="settings-footnote">现场没有网络时点「另存为文件」，把保存的 .tbdiag.gz 文件发给售后。提交或另存后，运行日志里会记一条，方便对照时间。</p>
  </form>;
}
