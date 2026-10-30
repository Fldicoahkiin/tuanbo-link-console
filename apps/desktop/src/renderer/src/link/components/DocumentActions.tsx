import { IconButton } from '../ui';
import { Redo2, Save, TriangleAlert, Undo2 } from 'lucide-react';
import { useDocumentStore } from '../stores/document-store';
import { useRecoveryCopyStore } from '../recovery-copy-writer';

export type DocumentActionProps = {
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
  historyDisabled?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
};

/** 另存为 and 恢复到上次保存 replace the path or the document, so they wait while playing. */
export type DocumentFileCommands = { replaceDisabled: boolean; onSaveAs: () => void; onRevert: () => void };

/** A browser download of the unsaved project, independent of the save path. */
export function downloadUnsavedProject(): void {
  const project = useDocumentStore.getState().project;
  if (!project) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = '未保存工程备份.tblink'; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Undo, redo and save on the title bar. 未保存 keeps its place while hidden, so the bar does not jump. */
export function DocumentActions({ canUndo, canRedo, disabled, historyDisabled = disabled, onUndo, onRedo, onSave }: DocumentActionProps): JSX.Element {
  const path = useDocumentStore((state) => state.path);
  const dirty = useDocumentStore((state) => state.dirty);
  const recoveryError = useRecoveryCopyStore((state) => state.error);
  return <div className="titlebar-actions" role="group" aria-label="工程编辑操作">
    <IconButton label="撤销" icon={Undo2} disabled={!canUndo || historyDisabled} onClick={onUndo} />
    <IconButton label="重做" icon={Redo2} disabled={!canRedo || historyDisabled} onClick={onRedo} />
    <span className="titlebar-save-state" role="status" data-dirty={dirty} aria-hidden={!dirty}>未保存</span>
    {recoveryError ? <span className="titlebar-recovery-error" role="alert" title={recoveryError} aria-label={recoveryError}><TriangleAlert aria-hidden="true" /></span> : null}
    <IconButton label="保存工程" title={path ? '保存工程（Ctrl+S）' : '选择位置并保存工程（Ctrl+S）'} icon={Save} className="titlebar-save" data-dirty={dirty} disabled={disabled} onClick={onSave} />
  </div>;
}
