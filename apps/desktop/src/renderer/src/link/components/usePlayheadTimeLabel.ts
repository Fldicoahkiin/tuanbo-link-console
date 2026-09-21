import { useEffect, useState, type RefObject } from 'react';

export function usePlayheadTimeLabel(ref: RefObject<HTMLElement>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = (event: PointerEvent): void => {
      const target = event.target;
      setVisible(target instanceof Element && Boolean(ref.current?.contains(target))
        && !target.closest('.waveform-cue-point')
        && Boolean(target.closest('.waveform-lane,.timeline-ruler,.timeline-playhead,.waveform-cue-points')));
    };
    window.addEventListener('pointerdown', update, true);
    return () => window.removeEventListener('pointerdown', update, true);
  }, [ref]);
  return visible;
}
