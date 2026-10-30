import { useId, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import { ModalSurface } from './ModalSurface';

/**
 * A modal dialog: title and close button on top, the content, then the actions (the main action
 * last). Escape and the close button call `onClose`; the window behind cannot be reached meanwhile.
 */
export function Dialog({ title, description, actions, size = 'md', closeLabel = '关闭', onClose, children }: {
  title: string;
  /** Names the close button when 关闭 alone would be unclear next to other windows. */
  closeLabel?: string;
  description?: ReactNode;
  actions?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  onClose: () => void;
  children?: ReactNode;
}): JSX.Element {
  const id = useId();
  return <ModalSurface label={title} className="ui-dialog" onClose={onClose}>
    <div className="ui-dialog-frame" data-size={size} aria-describedby={description ? `${id}-description` : undefined}>
      <header className="ui-dialog-header">
        <div>
          <h2>{title}</h2>
          {description ? <p id={`${id}-description`}>{description}</p> : null}
        </div>
        <IconButton label={closeLabel} icon={X} onClick={onClose} />
      </header>
      {children ? <div className="ui-dialog-body">{children}</div> : null}
      {actions ? <footer className="ui-dialog-actions">{actions}</footer> : null}
    </div>
  </ModalSurface>;
}
