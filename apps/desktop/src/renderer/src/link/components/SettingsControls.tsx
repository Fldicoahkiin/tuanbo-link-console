import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { CheckCircle2, ChevronRight, CircleAlert, Eye, EyeOff, Info, LoaderCircle } from 'lucide-react';
import { Button } from '../ui/Button';
import { ModalSurface } from '../ui/ModalSurface';

export function SettingsPageHeader({ title, description, scope, status }: { title: string; description: string; scope: string; status?: ReactNode }): JSX.Element {
  return <header className="settings-page-header"><div><div className="settings-page-title"><h1>{title}</h1><span className="settings-scope">{scope}</span></div><p>{description}</p></div>{status}</header>;
}

export function SettingsGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }): JSX.Element {
  return <section className="settings-group"><h2>{title}</h2>{description ? <p className="settings-note">{description}</p> : null}{children}</section>;
}

export function SettingsField({ label, help, error, children, wide = false }: { label: string; help?: string; error?: string; children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactNode; wide?: boolean }): JSX.Element {
  const id = useId();
  return <div className={`settings-field-row${wide ? ' settings-field-wide' : ''}`}><label htmlFor={id}>{label}</label><div className="settings-field-control">{children({ id, ...(help || error ? { 'aria-describedby': `${id}-help` } : {}), ...(error ? { 'aria-invalid': true as const } : {}) })}{help || error ? <p id={`${id}-help`} className={error ? 'settings-field-error' : 'settings-field-help'}>{error ?? help}</p> : null}</div></div>;
}

export function SettingsPassword(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>): JSX.Element {
  const [visible, setVisible] = useState(false);
  return <div className="settings-password"><input {...props} type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} /><Button type="button" disabled={props.disabled} aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</Button></div>;
}

export function SettingsSwitch({ label, help, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string; help?: string }): JSX.Element {
  const id = useId();
  return <label className="settings-switch-row"><span>{label}{help ? <small id={`${id}-help`}>{help}</small> : null}</span><input {...props} type="checkbox" role="switch" aria-label={props['aria-label'] ?? label} aria-describedby={help ? `${id}-help` : undefined} /></label>;
}

export function SettingsFeedback({ tone = 'info', children }: { tone?: 'info' | 'success' | 'warning' | 'error' | 'busy'; children: ReactNode }): JSX.Element {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'warning' || tone === 'error' ? CircleAlert : tone === 'busy' ? LoaderCircle : Info;
  return <div className={`settings-feedback tone-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><Icon aria-hidden="true" /><div>{children}</div></div>;
}

export function SettingsActions({ children }: { children: ReactNode }): JSX.Element {
  return <div className="settings-actions">{children}</div>;
}

export function SettingsDisclosure({ title, description, children, open, onToggle }: { description?: string; title: string; children: ReactNode; open?: boolean; onToggle?: (open: boolean) => void }): JSX.Element {
  return <details className="settings-disclosure" open={open} onToggle={event => onToggle?.(event.currentTarget.open)}><summary><span className="settings-disclosure-copy"><span>{title}</span>{description ? <small>{description}</small> : null}</span><ChevronRight aria-hidden="true" /></summary><div className="settings-disclosure-body">{children}</div></details>;
}

export function SettingsConfirm({ title, children, confirmLabel, cancelLabel = '取消', onConfirm, onClose }: { cancelLabel?: string; title: string; children: ReactNode; confirmLabel: string; onConfirm: () => void; onClose: () => void }): JSX.Element {
  return <ModalSurface label={title} className="settings-confirm" onClose={onClose}><h2>{title}</h2><div className="settings-confirm-copy">{children}</div><div className="settings-actions"><Button className="secondary-button" onClick={onClose}>{cancelLabel}</Button><Button className="primary-button" onClick={onConfirm}>{confirmLabel}</Button></div></ModalSurface>;
}
