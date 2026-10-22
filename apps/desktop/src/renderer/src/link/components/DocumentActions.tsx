import { Button } from './Button';
import { Download, History, Redo2, Save, SaveAll, TriangleAlert, Undo2 } from 'lucide-react';
import { useDocumentStore } from '../stores/document-store';
import { useRecoveryCopyStore } from '../recovery-copy-writer';

export type DocumentActionProps = {
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
  historyDisabled?: boolean;
  /** Save As and revert replace the path or the document: unavailable while playing. */
  replaceDisabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onRevert: () => void;
};

export function DocumentActions({ canUndo, canRedo, disabled, historyDisabled = disabled, replaceDisabled, onUndo, onRedo, onSave, onSaveAs, onRevert }: DocumentActionProps): JSX.Element {
  const path = useDocumentStore((state) => state.path);
  const dirty = useDocumentStore((state) => state.dirty);
  const recoveryError = useRecoveryCopyStore((state) => state.error);
  return <div className="document-actions" aria-label="工程编辑操作">
    <Button className="icon-button" disabled={!canUndo || historyDisabled} onClick={onUndo} title="撤销" aria-label="撤销"><Undo2 /></Button>
    <Button className="icon-button" disabled={!canRedo || historyDisabled} onClick={onRedo} title="重做" aria-label="重做"><Redo2 /></Button>
    <span className="project-save-status" role="status" style={{ visibility: dirty ? 'visible' : 'hidden' }} aria-hidden={!dirty}>未保存</span>
    {recoveryError ? <span className="project-recovery-error" role="alert" title={recoveryError} aria-label={recoveryError}><TriangleAlert aria-hidden="true" /></span> : null}
    <Button className="secondary-button document-save-button" data-dirty={dirty} disabled={disabled} onClick={onSave} title={path ? '保存工程（Ctrl+S）' : '选择位置并保存工程（Ctrl+S）'} aria-label="保存工程"><Save />保存</Button>
    <Button className="icon-button" disabled={replaceDisabled} onClick={onSaveAs} title="另存为（Ctrl+Shift+S）" aria-label="另存为"><SaveAll /></Button>
    <Button className="icon-button" disabled={replaceDisabled || !path || !dirty} onClick={onRevert} title="恢复到上次保存：放弃所有未保存修改" aria-label="恢复到上次保存"><History /></Button>
    <Button className="icon-button" style={{ visibility: dirty ? 'visible' : 'hidden' }} disabled={!dirty} aria-hidden={!dirty} tabIndex={dirty ? 0 : -1} title="备份未保存工程" aria-label="备份未保存工程" onClick={() => {
      const project = useDocumentStore.getState().project;
      if (!project) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = '未保存工程备份.tblink'; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}><Download /></Button>
  </div>;
}
