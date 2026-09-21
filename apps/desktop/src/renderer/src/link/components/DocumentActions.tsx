import { Button } from './Button';
import { Download, Redo2, Save, Undo2 } from 'lucide-react';
import { useDocumentStore } from '../stores/document-store';

export type DocumentActionProps = {
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
  historyDisabled?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
};

export function DocumentActions({ canUndo, canRedo, disabled, historyDisabled = disabled, onUndo, onRedo, onSave }: DocumentActionProps): JSX.Element {
  const path = useDocumentStore((state) => state.path);
  const dirty = useDocumentStore((state) => state.dirty);
  return <div className="document-actions" aria-label="工程编辑操作">
    <Button className="icon-button" disabled={!canUndo || historyDisabled} onClick={onUndo} title="撤销" aria-label="撤销"><Undo2 /></Button>
    <Button className="icon-button" disabled={!canRedo || historyDisabled} onClick={onRedo} title="重做" aria-label="重做"><Redo2 /></Button>
    {path ? <span className="project-save-status" role="status">{dirty ? '待自动保存' : '已自动保存'}</span> : <Button className="secondary-button document-save-button" disabled={disabled} onClick={onSave} title="保存工程" aria-label="保存工程"><Save />选择保存位置</Button>}
    {dirty ? <Button className="icon-button" title="备份未保存工程" aria-label="备份未保存工程" onClick={() => {
      const project = useDocumentStore.getState().project;
      if (!project) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = '未保存工程备份.tblink'; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}><Download /></Button> : null}
  </div>;
}
