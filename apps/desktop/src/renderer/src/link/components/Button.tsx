import { forwardRef, type ButtonHTMLAttributes } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean };

/** Keeps existing native form semantics, refs and event targets during visual migration. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { loading = false, disabled, className = '', children, ...props }, ref
) {
  return <button {...props} ref={ref} className={`ui-button ${className}`}
    disabled={disabled || loading} aria-busy={loading || props['aria-busy']}>
    {children}
  </button>;
});
