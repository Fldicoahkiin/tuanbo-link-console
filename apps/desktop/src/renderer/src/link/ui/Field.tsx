import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { IconButton } from './Button';

export type FieldControlProps = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true };

/**
 * A labelled control: the label on the left, the control and its help or error under each other on the
 * right. `stacked` puts the label above, for narrow panels. The control is rendered by `children`, which
 * receives the id and the description it must carry.
 */
export function Field({ label, help, error, stacked = false, children }: {
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  stacked?: boolean;
  children: (props: FieldControlProps) => ReactNode;
}): JSX.Element {
  const id = useId();
  const described = help || error ? `${id}-note` : undefined;
  return <div className="ui-field" data-layout={stacked ? 'stacked' : 'row'}>
    <label className="ui-field-label" htmlFor={id}>{label}</label>
    <div className="ui-field-control">
      {children({ id, ...(described ? { 'aria-describedby': described } : {}), ...(error ? { 'aria-invalid': true as const } : {}) })}
      {error ? <p id={described} className="ui-field-note" data-tone="error" role="alert">{error}</p>
        : help ? <p id={described} className="ui-field-note">{help}</p> : null}
    </div>
  </div>;
}

/** A one-line text or number input. */
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { width?: 'auto' | 'full' }>(function TextInput(
  { className, width = 'full', ...props }, ref
) {
  return <input {...props} ref={ref} className={className ? `ui-input ${className}` : 'ui-input'} data-width={width} />;
});

/** Several lines of text, as long as the page allows; the user can make it taller. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...props }, ref) {
  return <textarea {...props} ref={ref} className={className ? `ui-input ${className}` : 'ui-input'} />;
});

/**
 * A secret, hidden unless the eye button is pressed; never autofilled or spell-checked. `secret` names
 * it on the button (显示密码, 显示激活码).
 */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { secret?: string }>(function PasswordInput(
  { className, disabled, secret = '密码', ...props }, ref
) {
  const [visible, setVisible] = useState(false);
  return <span className="ui-password">
    <input {...props} ref={ref} disabled={disabled} className={className ? `ui-input ${className}` : 'ui-input'} type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} />
    <IconButton type="button" size="sm" label={visible ? `隐藏${secret}` : `显示${secret}`} icon={visible ? EyeOff : Eye} aria-pressed={visible} onClick={() => setVisible(value => !value)} />
  </span>;
});

/** A native drop-down with the shared look; options are its children. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { width?: 'auto' | 'full' }>(function Select(
  { className, width = 'full', children, ...props }, ref
) {
  return <span className={className ? `ui-select ${className}` : 'ui-select'} data-width={width}>
    <select {...props} ref={ref}>{children}</select>
    <ChevronDown aria-hidden="true" />
  </span>;
});

/** A number box with its unit (%, 秒, BPM) inside, after the value; the input is `children`. */
export function WithUnit({ unit, children }: { unit: string; children: ReactNode }): JSX.Element {
  return <span className="ui-unit">{children}<small aria-hidden="true">{unit}</small></span>;
}

/** An on/off setting that applies at once; `help` explains what "on" does. */
export function Switch({ label, help, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'> & { label: ReactNode; help?: ReactNode }): JSX.Element {
  const id = useId();
  return <label className={className ? `ui-switch ${className}` : 'ui-switch'}>
    <span className="ui-switch-text">
      <span className="ui-switch-label" id={`${id}-label`}>{label}</span>
      {help ? <small id={`${id}-help`}>{help}</small> : null}
    </span>
    <input {...props} type="checkbox" role="switch" aria-labelledby={props['aria-label'] ? undefined : `${id}-label`} aria-describedby={help ? `${id}-help` : props['aria-describedby']} />
  </label>;
}
