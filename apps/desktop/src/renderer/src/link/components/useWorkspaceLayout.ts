import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';

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
  resizeWithKeyboard: (target: ResizeTarget, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
} {
  const [initial] = useState(readLayout);
  const [layout, setLayout] = useState<WorkspaceLayout>(initial.layout);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
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
    if (event.button !== 0) return;
    dragCleanup.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = layout;
    const inspectorStartWidth = event.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? start.inspectorWidth;
    const timelineStartHeight = event.currentTarget.nextElementSibling?.getBoundingClientRect().height ?? start.timelineHeight;
    const limits = resizeLimits(target, event.currentTarget);
    const onMove = (moveEvent: PointerEvent): void => {
      if (target === 'resource') {
        setLayout((current) => ({ ...current, resourceWidth: clamp(start.resourceWidth + moveEvent.clientX - startX, ...limits) }));
      } else if (target === 'inspector') {
        const width = clamp(inspectorStartWidth - moveEvent.clientX + startX, ...limits);
        setLayout((current) => ({ ...current, inspectorWidth: width }));
      } else {
        setLayout((current) => ({ ...current, timelineHeight: clamp(timelineStartHeight - moveEvent.clientY + startY, ...limits) }));
      }
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onUp);
      document.body.classList.remove('is-resizing-workspace');
      dragCleanup.current = null;
    };
    document.body.classList.add('is-resizing-workspace');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onUp);
    dragCleanup.current = onUp;
  };

  return {
    style: {
      '--resource-width': `${layout.resourceWidth}px`,
      '--inspector-width': `${layout.inspectorWidth}px`,
      '--timeline-height': `${layout.timelineHeight}px`,
      '--preview-inspector-width': `${layout.inspectorWidth}px`
    },
    beginResize,
    resizeWithKeyboard: (target, event) => {
      const keys = target === 'timeline' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const delta = event.key === keys[0] ? 20 : -20;
      const limits = resizeLimits(target, event.currentTarget);
      setLayout(current => target === 'timeline'
        ? { ...current, timelineHeight: clamp(current.timelineHeight + delta, ...limits) }
        : target === 'inspector' ? { ...current, inspectorWidth: clamp(current.inspectorWidth + delta, ...limits) }
          : { ...current, resourceWidth: clamp(current.resourceWidth - delta, ...limits) });
    }
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
        resourceWidth: Math.max(160, parsed.resourceWidth),
        inspectorWidth: Math.max(180, parsed.inspectorWidth),
        timelineHeight: Math.max(140, parsed.timelineHeight)
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

function resizeLimits(target: ResizeTarget, element: HTMLButtonElement): [number, number] {
  const bounds = element.parentElement!.getBoundingClientRect();
  const minimum = target === 'timeline' ? 140 : target === 'inspector' ? 180 : 160;
  const maximum = target === 'timeline' ? bounds.height - 108 : bounds.width - 168;
  return [minimum, Math.max(minimum, maximum)];
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
