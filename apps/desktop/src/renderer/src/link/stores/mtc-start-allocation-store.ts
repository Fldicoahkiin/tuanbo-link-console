import { create } from 'zustand';

/**
 * Why the last automatic MTC start allocation failed, shown on the songs still waiting for one.
 * `context` names the project and console session it failed for; another attempt waits for either
 * to change or for `retryAt`.
 */
export const useMtcStartAllocationStore = create<{ error: string | null; context: string; retryAt: number }>(() => ({ error: null, context: '', retryAt: 0 }));
