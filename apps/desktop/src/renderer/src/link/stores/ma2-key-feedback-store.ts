import { create } from 'zustand';

/**
 * What the console page shows of its own key presses (C1), by executor ("page.slot"): a press on its way, and the last
 * press that did not reach the console. Only this computer's presses: whether the executor runs, and its Cue, come only
 * from what the console reads back, never from here. A failure stays on its cell until that executor is pressed again;
 * the next press is sent as usual.
 */
export const useMa2KeyFeedbackStore = create<{ sending: Record<string, number>; failed: Record<string, string> }>(() => ({ sending: {}, failed: {} }));

/** How the key controller reports to the page (`createMa2ExecutorInput`). */
export type Ma2KeyFeedback = {
  sending: (address: string) => void;
  settled: (address: string) => void;
  failed: (address: string, message: string) => void;
};

export const ma2KeyFeedback: Ma2KeyFeedback = {
  sending: address => useMa2KeyFeedbackStore.setState(state => {
    const failed = { ...state.failed }; delete failed[address];
    return { sending: { ...state.sending, [address]: (state.sending[address] ?? 0) + 1 }, failed };
  }),
  settled: address => useMa2KeyFeedbackStore.setState(state => {
    const sending = { ...state.sending }; const left = (sending[address] ?? 0) - 1;
    if (left > 0) sending[address] = left; else delete sending[address];
    return { sending };
  }),
  failed: (address, message) => useMa2KeyFeedbackStore.setState(state => ({ failed: { ...state.failed, [address]: message } }))
};

/** The page changed console or Show: nothing it showed of earlier presses applies any more. */
export function clearMa2KeyFeedback(): void { useMa2KeyFeedbackStore.setState({ sending: {}, failed: {} }); }
