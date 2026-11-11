import { create } from 'zustand';

/**
 * Whether the operator connected the console's web remote from the console page in this run (C1). Until then the page
 * reads nothing on the web remote: it does not log in for live state on its own, saved user or not. For this run only;
 * after a restart the operator presses “连接网页遥控” once (the saved user logs in without the form).
 */
export const useMa2WebRemoteStore = create<{ wanted: boolean }>(() => ({ wanted: false }));

export function wantMa2WebRemote(): void { useMa2WebRemoteStore.setState({ wanted: true }); }
