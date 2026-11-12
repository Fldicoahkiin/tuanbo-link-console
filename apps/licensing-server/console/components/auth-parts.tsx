import { useState, type ComponentProps } from 'react';
import { Check, Download, Eye, EyeOff } from 'lucide-react';
import { cn } from '../lib/utils';
import { CopyButton } from './copy-button';
import { Button } from './ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './ui/input-group';

/** 密码框，右侧一个显示 / 隐藏的眼睛按钮。点眼睛不会把焦点从输入框里拿走。 */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const [shown, setShown] = useState(false);
  return <InputGroup className={cn('h-9', className)}>
    <InputGroupInput {...props} type={shown ? 'text' : 'password'} />
    <InputGroupAddon align="inline-end">
      <InputGroupButton size="icon-xs" aria-label={shown ? '隐藏密码' : '显示密码'} title={shown ? '隐藏密码' : '显示密码'}
        onMouseDown={event => event.preventDefault()} onClick={() => setShown(value => !value)}>
        {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </InputGroupButton>
    </InputGroupAddon>
  </InputGroup>;
}

const steps = ['填开通凭据', '绑定验证器', '保存恢复码'] as const;

/** 开通的三步进度：当前步高亮，做完的打勾。 */
export function EnrollSteps({ current }: { current: 1 | 2 | 3 }) {
  return <ol aria-label="开通步骤" className="flex items-center gap-2 text-xs">
    {steps.map((label, index) => {
      const step = index + 1;
      const done = step < current;
      const active = step === current;
      return <li key={label} aria-current={active ? 'step' : undefined} className={cn('flex min-w-0 items-center gap-1.5', step < steps.length && 'flex-1')}>
        <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border tabular-nums',
          active && 'border-primary bg-primary text-primary-foreground', done && 'border-primary text-primary', !active && !done && 'text-muted-foreground')}>
          {done ? <Check className="size-3" aria-hidden="true" /> : step}
        </span>
        <span className={cn('whitespace-nowrap', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>
          {label}{done && <span className="sr-only">（已完成）</span>}
        </span>
        {step < steps.length && <span aria-hidden="true" className={cn('h-px min-w-2 flex-1', done ? 'bg-primary' : 'bg-border')} />}
      </li>;
    })}
  </ol>;
}

/** 设置密码时实时说还差几位。 */
export function PasswordLength({ id, length, minimum }: { id: string; length: number; minimum: number }) {
  const short = minimum - length;
  return <p id={id} className={cn('flex items-center gap-1 text-xs', short > 0 ? 'text-muted-foreground' : 'text-success')}>
    {short > 0 ? `还差 ${short} 位` : <><Check className="size-3.5" aria-hidden="true" />长度够了</>}
  </p>;
}

/** 第 3 步的恢复码：等宽字体一枚一行（每枚 32 位，卡片宽度放不下两列），可以复制全部或存成文本文件。 */
export function RecoveryCodes({ codes, username }: { codes: string[]; username: string }) {
  const text = codes.join('\n');
  function download() {
    const url = URL.createObjectURL(new Blob([`团播联动台运营后台恢复码${username ? `（${username}）` : ''}\n每枚只能用一次。\n\n${text}\n`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    // 文件名只用英文：有的浏览器遇到中文文件名会改成「download」。
    link.download = `tblink-console-recovery-codes${username ? `-${username}` : ''}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="flex flex-col gap-3">
    <ul data-testid="recovery-codes" className="grid grid-cols-1 gap-y-1.5 rounded-lg bg-muted px-4 py-3 font-mono text-sm tabular-nums select-all">
      {codes.map(code => <li key={code}>{code}</li>)}
    </ul>
    <div className="flex flex-wrap gap-2">
      <CopyButton value={text} size="default" className="h-9">复制全部</CopyButton>
      <Button type="button" variant="outline" className="h-9" onClick={download}><Download aria-hidden="true" />下载为文本文件</Button>
    </div>
  </div>;
}
