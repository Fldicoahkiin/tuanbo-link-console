import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

type ResizeTarget = 'resource' | 'inspector' | 'timeline';

type WorkspaceLayout = {
  resourceWidth: number;
  inspectorWidth: number;
  timelineHeight: number;
};

export type WorkspaceLayoutStyle = CSSProperties & {
  '--resource-width': string;
  '--inspector-width': string;
  '--timeline-height': string;
  '--preview-inspector-width': string;
};

const STORAGE_KEY = 'tblink.cue-workspace-layout.v1';
const DEFAULT_LAYOUT: WorkspaceLayout = { resourceWidth: 390, inspectorWidth: 330, timelineHeight: 360 };

export function useWorkspaceLayout(notify: (message: string, tone?: 'info' | 'error') => void): {
  style: WorkspaceLayoutStyle;
  beginResize: (target: ResizeTarget, event: ReactPointerEvent<HTMLButtonElement>) => void;
} {
  const [initial] = useState(readLayout);
  const [layout, setLayout] = useState<WorkspaceLayout>(initial.layout);
  const [previewInspectorWidth, setPreviewInspectorWidth] = useState<number | null>(null);
  const writeFailureReported = useRef(false);
  useEffect(() => {
    if (initial.error) notify(`工作区布局恢复失败：${initial.error}；已使用默认布局`, 'error');
  }, [initial.error, notify]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
      writeFailureReported.current = false;
    } catch (error) {
      if (!writeFailureReported.current) {
        writeFailureReported.current = true;
        notify(`工作区布局保存失败：${toMessage(error)}`, 'error');
      }
    }
  }, [layout, notify]);

  const beginResize = (target: ResizeTarget, event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = layout;
    const inspectorStartWidth = event.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? start.inspectorWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      if (target === 'resource') {
        setLayout((current) => ({ ...current, resourceWidth: clamp(start.resourceWidth + moveEvent.clientX - startX, 280, 560) }));
      } else if (target === 'inspector') {
        const width = clamp(inspectorStartWidth - moveEvent.clientX + startX, 260, 700);
        setPreviewInspectorWidth(width);
        setLayout((current) => ({ ...current, inspectorWidth: Math.min(480, width) }));
      } else {
        setLayout((current) => ({ ...current, timelineHeight: clamp(start.timelineHeight - moveEvent.clientY + startY, 280, 620) }));
      }
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('is-resizing-workspace');
    };
    document.body.classList.add('is-resizing-workspace');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return {
    style: {
      '--resource-width': `${layout.resourceWidth}px`,
      '--inspector-width': `${layout.inspectorWidth}px`,
      '--timeline-height': `${layout.timelineHeight}px`,
      '--preview-inspector-width': previewInspectorWidth === null ? '50%' : `${previewInspectorWidth}px`
    },
    beginResize
  };
}

function readLayout(): { layout: WorkspaceLayout; error: string | null } {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return { layout: DEFAULT_LAYOUT, error: null };
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed) || !isFiniteNumber(parsed.resourceWidth) || !isFiniteNumber(parsed.inspectorWidth) || !isFiniteNumber(parsed.timelineHeight)) {
      return { layout: DEFAULT_LAYOUT, error: '已保存的尺寸结构无效' };
    }
    return {
      layout: {
        resourceWidth: clamp(parsed.resourceWidth, 280, 560),
        inspectorWidth: clamp(parsed.inspectorWidth, 260, 480),
        timelineHeight: clamp(parsed.timelineHeight, 280, 620)
      },
      error: null
    };
  } catch (error) {
    return { layout: DEFAULT_LAYOUT, error: toMessage(error) };
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
