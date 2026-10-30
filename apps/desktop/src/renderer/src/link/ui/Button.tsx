import { forwardRef, type ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ControlSize = 'sm' | 'md';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Without a variant the button keeps the look of the legacy page it sits on, until that page is redone. */
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
  icon?: LucideIcon;
};

/** The one button: native form semantics, refs and event targets, styled by link/ui/ui.css. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size = 'md', loading = false, icon: Icon, disabled, className, children, ...props }, ref
) {
  return <button {...props} ref={ref} className={className ? `ui-button ${className}` : 'ui-button'}
    data-variant={variant} data-size={variant ? size : undefined}
    disabled={disabled || loading} aria-busy={loading || props['aria-busy']}>
    {Icon ? <Icon aria-hidden="true" /> : null}{children}
  </button>;
});

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
  /** Read by screen readers and shown as the tooltip. */
  label: string;
  icon: LucideIcon;
  variant?: Exclude<ButtonVariant, 'primary'>;
  size?: ControlSize;
};

/** A square button with only an icon; its label is the accessible name and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon: Icon, variant = 'ghost', size = 'md', className, title, ...props }, ref
) {
  return <button {...props} ref={ref} className={className ? `ui-icon-button ${className}` : 'ui-icon-button'}
    data-variant={variant} data-size={size} aria-label={label} title={title ?? label}>
    <Icon aria-hidden="true" />
  </button>;
});
