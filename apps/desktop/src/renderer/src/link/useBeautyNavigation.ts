import { useEffect } from 'react';
import { useBeautyStore } from './stores/beauty-store';

export function useBeautyNavigation(onOpen: () => void): void {
  const requested = useBeautyStore(state => state.panelOpen);
  useEffect(() => {
    if (!requested) return;
    onOpen();
    useBeautyStore.getState().setPanelOpen(false);
  }, [requested, onOpen]);
}
