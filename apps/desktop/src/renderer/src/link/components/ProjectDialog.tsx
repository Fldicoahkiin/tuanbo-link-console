import { Button } from '../ui/Button';
import { FilePlus2 } from 'lucide-react';
import { ModalSurface } from '../ui/ModalSurface';

export function ProjectDialog({ name, error, onNameChange, onClose, onCreate }: {
  name: string;
  error: string | null;
  onNameChange: (name: string) => void;
  onClose: () => void;
  onCreate: () => void;
}): JSX.Element {
  return <ModalSurface className="modal-card project-dialog" label="新建联动工程" onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate(); }}>
      <FilePlus2 className="dialog-symbol" aria-hidden="true" />
      <h2 id="project-dialog-title">新建联动工程</h2>
      <p>创建一份独立的节目单，开始编排音乐、画面和灯光。当前工程会先保存。</p>
      <label className="field"><span>工程名称</span><input autoFocus required value={name} onChange={(event) => onNameChange(event.currentTarget.value)} /></label>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <div className="modal-actions"><Button type="button" className="secondary-button" onClick={onClose}>取消</Button><Button type="submit" className="primary-button" disabled={!name.trim()}>创建工程</Button></div>
    </form>
  </ModalSurface>;
}
