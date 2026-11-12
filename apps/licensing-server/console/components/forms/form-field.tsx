import type { ReactNode } from 'react';
import { extendBeijing, toBeijingInput, type Field as FieldSpec } from '../../forms';
import { Button } from '../ui/button';
import { Field, FieldError, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';

/** 对话框里一个字段的控件 id：出错时按它把焦点放回去。 */
export const fieldId = (prefix: string, key: string) => `${prefix}-${key}`;

type Props = {
  field: FieldSpec; id: string; value: string; error: string | undefined; disabled: boolean; clockOffset: number;
  onChange: (value: string) => void; onBlur: () => void;
};

const lengthOf = (field: FieldSpec) => field.maxLength ?? (field.type === 'textarea' || field.type === 'preset' ? 500 : 160);
const extendSteps: readonly [string, number][] = [['+7 天', 7], ['+30 天', 30], ['+1 年', 365]];

/** 表单里的一个字段：标签、控件、快捷按钮或常用项、字段下面的错误。值由对话框的状态管。 */
export function FormField({ field, id, value, error, disabled, clockOffset, onChange, onBlur }: Props) {
  if (field.type === 'hidden') return <input type="hidden" name={field.key} value={value} />;
  const invalid = error ? true : undefined;
  const common = { id, name: field.key, disabled, 'aria-invalid': invalid, onBlur, autoComplete: 'off' };
  let control: ReactNode;
  let below: ReactNode = null;
  if (field.type === 'select') {
    const items = (field.options ?? []).map(([option, label]) => ({ value: option, label }));
    control = <Select name={field.key} items={items} value={value} disabled={disabled} onValueChange={next => onChange(typeof next === 'string' ? next : '')}>
      <SelectTrigger id={id} aria-invalid={invalid} onBlur={onBlur} className="w-full data-[size=default]:h-9">
        <SelectValue placeholder={`请选择${field.label}`} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
      </SelectContent>
    </Select>;
  } else if (field.type === 'textarea') {
    control = <Textarea {...common} rows={3} maxLength={lengthOf(field)} placeholder={field.placeholder} value={value} onChange={event => onChange(event.target.value)} />;
  } else if (field.type === 'money') {
    control = <InputGroup className="h-9">
      <InputGroupInput {...common} inputMode="decimal" value={value} onChange={event => onChange(event.target.value)} />
      <InputGroupAddon align="inline-end">元</InputGroupAddon>
    </InputGroup>;
  } else {
    const kind = field.type === 'datetime-local' ? 'datetime-local' : 'text';
    control = <Input {...common} className="h-9" type={kind} inputMode={field.type === 'number' ? 'numeric' : undefined}
      maxLength={field.type === undefined || field.type === 'preset' ? lengthOf(field) : undefined}
      placeholder={field.placeholder} value={value} onChange={event => onChange(event.target.value)} />;
    if (field.type === 'preset') below = <Presets field={field} value={value} disabled={disabled} onPick={onChange} />;
    if (field.shortcuts === 'extend') {
      below = <Shortcuts>
        {extendSteps.map(([label, days]) => <Button key={label} type="button" variant="outline" size="sm" className="text-foreground max-sm:h-9" disabled={disabled}
          onClick={() => onChange(extendBeijing(value, days, Date.now() + clockOffset))}>{label}</Button>)}
      </Shortcuts>;
    }
    if (field.shortcuts === 'now') {
      below = <Shortcuts>
        <Button type="button" variant="outline" size="sm" className="text-foreground max-sm:h-9" disabled={disabled} onClick={() => onChange(toBeijingInput(Date.now() + clockOffset))}>现在</Button>
      </Shortcuts>;
    }
  }
  return <Field data-invalid={invalid} className="gap-2">
    <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
    {control}
    {error && <FieldError>{error}</FieldError>}
    {below}
  </Field>;
}

/** 日期下面的快捷按钮。 */
function Shortcuts({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

/** 原因、付款方式下面的常用项：点一下填进输入框，再点同一个清空；手动改过就都不高亮。 */
function Presets({ field, value, disabled, onPick }: { field: FieldSpec; value: string; disabled: boolean; onPick: (value: string) => void }) {
  return <div role="group" aria-label={`常用${field.label}`} className="flex flex-wrap gap-2">
    {(field.options ?? []).map(([option, label]) => {
      const pressed = value === option;
      return <Button key={option} type="button" variant="outline" size="sm" aria-pressed={pressed} disabled={disabled}
        className="text-foreground max-sm:h-9 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/15"
        onClick={() => onPick(pressed ? '' : option)}>{label}</Button>;
    })}
  </div>;
}
