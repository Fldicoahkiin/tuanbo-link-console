import { useEffect, useRef, useState } from 'react';

export function useAudioRowHeight(rows: number, rulerHeight: number) {
  const timelineRef = useRef<HTMLElement>(null);
  const [requestedHeight, setAudioHeight] = useState<number | null>(null);
  const [availableHeight, setAvailableHeight] = useState(360);
  useEffect(() => {
    const viewport = timelineRef.current?.querySelector('.timeline-viewport');
    if (!viewport) return;
    let previousHeight = -1;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]; if (!entry) return;
      const height = Math.max(1, Math.floor((entry.contentRect.height - rulerHeight - 5) / rows));
      if (height === previousHeight) return;
      previousHeight = height;
      setAvailableHeight(height);
      setAudioHeight(null);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [rows, rulerHeight]);
  return { timelineRef, audioHeight: Math.min(requestedHeight ?? availableHeight, availableHeight), setAudioHeight };
}
