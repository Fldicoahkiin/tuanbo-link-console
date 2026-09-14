import { Redo2, Save, Undo2 } from 'lucide-react';
import { useDocumentStore } from '../stores/document-store';

export type DocumentActionProps = {
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
};

export function DocumentActions({ canUndo, canRedo, disabled, onUndo, onRedo, onSave }: DocumentActionProps): JSX.Element {
  const path = useDocumentStore((state) => state.path);
  const dirty = useDocumentStore((state) => state.dirty);
  return <div className="document-actions" aria-label="工程编辑操作">
    <button className="icon-button" disabled={!canUndo || disabled} onClick={onUndo} title="撤销" aria-label="撤销"><Undo2 /></button>
    <button className="icon-button" disabled={!canRedo || disabled} onClick={onRedo} title="重做" aria-label="重做"><Redo2 /></button>
    {path ? <span className="project-save-status" role="status">{dirty ? '待自动保存' : '已自动保存'}</span> : <button className="secondary-button document-save-button" disabled={disabled} onClick={onSave} title="保存工程" aria-label="保存工程"><Save />选择保存位置</button>}
  </div>;
}
