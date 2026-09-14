import { useState, type DragEvent } from 'react';
import { MEDIA_DRAG_TYPE, OBS_DRAG_TYPE } from './ResourceLibrary';

export function TimelineNewLayerDrop({ active, onDrop }: { active: boolean; onDrop: (event: DragEvent<HTMLElement>) => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  return <div className={`timeline-new-layer-drop ${hover || active ? 'is-drop-target' : ''}`} data-new-visual-layer="" aria-label="拖到此处新建时间线"
    onDragOver={(event) => {
      if (!event.dataTransfer.types.some((type) => type === MEDIA_DRAG_TYPE || type === OBS_DRAG_TYPE)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setHover(true);
    }}
    onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setHover(false); }}
    onDrop={(event) => { setHover(false); onDrop(event); }}>
    <span>{hover || active ? '松开新建时间线' : '拖动素材到这里，自动新建时间线'}</span>
  </div>;
}
