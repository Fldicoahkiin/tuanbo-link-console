import { useEffect, useRef, type ReactNode } from 'react';

/** Native modal semantics provide inert background, Escape and a contained tab order. */
export function ModalSurface({ children, label, className, onClose }: {
  children: ReactNode;
  label: string;
  className: string;
  onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return <dialog ref={dialogRef} className={`modal-surface ${className}`} aria-label={label}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>{children}</dialog>;
}
