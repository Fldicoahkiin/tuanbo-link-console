import { create } from 'zustand';
import type { IntegrationProfile, NativePlaybackDevices } from '@tb/schema';
import type { LinkAppInfo, LinkObsInventory, LinkObsSnapshot, LinkProcessSnapshot } from '@tb/core/link';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';

export type IntegrationStoreState = {
  initialized: boolean;
  profile: IntegrationProfile | null;
  appInfo: LinkAppInfo | null;
  securityAvailable: boolean;
  obs: LinkObsSnapshot;
  inventory: LinkObsInventory | null;
  processes: Record<LinkProcessSnapshot['id'], LinkProcessSnapshot>;
  midiPorts: MidiPortSnapshot[];
  nativeDevices: NativePlaybackDevices | null;
  nativeDeviceError: string | null;
  error: string | null;
  setInitialized: (initialized: boolean) => void;
  setProfile: (profile: IntegrationProfile | null) => void;
  setAppInfo: (info: LinkAppInfo) => void;
  setSecurityAvailable: (available: boolean) => void;
  setObs: (snapshot: LinkObsSnapshot) => void;
  setInventory: (inventory: LinkObsInventory | null) => void;
  setProcess: (snapshot: LinkProcessSnapshot) => void;
  setMidiPorts: (ports: MidiPortSnapshot[]) => void;
  setNativeDevices: (devices: NativePlaybackDevices | null, error: string | null) => void;
  setError: (error: string | null) => void;
};

const emptyProcess = (id: LinkProcessSnapshot['id']): LinkProcessSnapshot => ({
  id,
  status: 'notRunning',
  pid: null,
  processName: null,
  executablePath: null,
  startTime: null,
  windowTitle: null,
  fileVersion: null,
  owned: false,
  error: null
});

export const useIntegrationStore = create<IntegrationStoreState>((set) => ({
  initialized: false,
  profile: null,
  appInfo: null,
  securityAvailable: false,
  obs: { status: 'disconnected', obsVersion: null, webSocketVersion: null, error: null },
  inventory: null,
  processes: {
    obs: emptyProcess('obs'),
    p1: emptyProcess('p1')
  },
  midiPorts: [],
  nativeDevices: null,
  nativeDeviceError: null,
  error: null,
  setInitialized: (initialized) => set({ initialized }),
  setProfile: (profile) => set({ profile }),
  setAppInfo: (appInfo) => set({ appInfo }),
  setSecurityAvailable: (securityAvailable) => set({ securityAvailable }),
  setObs: (obs) => set({ obs }),
  setInventory: (inventory) => set({ inventory }),
  setProcess: (snapshot) => set((state) => ({
    processes: { ...state.processes, [snapshot.id]: snapshot }
  })),
  setMidiPorts: (midiPorts) => set({ midiPorts }),
  setNativeDevices: (nativeDevices, nativeDeviceError) => set({ nativeDevices, nativeDeviceError }),
  setError: (error) => set({ error })
}));
