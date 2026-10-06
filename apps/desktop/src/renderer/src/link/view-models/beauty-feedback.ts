import { beautyRuntimeKeys, type BeautyFilterState, type BeautyRuntimeState, type BeautyValues } from '@tb/schema';

export type BeautyFeedback = { tone: 'idle' | 'pending' | 'ready' | 'error'; text: string };
export function beautyFeedback(input: {
  connected: boolean; source: string; filter: string; confirmed: BeautyFilterState | null;
  values: BeautyValues; busy: boolean; error: string | null;
  runtime: BeautyRuntimeState | null; runtimeError: string;
}): BeautyFeedback {
  const { connected, source, filter, confirmed, values, busy, error, runtime, runtimeError } = input;
  if (!connected) return { tone: 'idle', text: '离线调节 · 参数未送到 OBS' };
  if (error || runtimeError) return { tone: 'error', text: error || runtimeError };
  if (runtime?.phase === 'error') return { tone: 'error', text: runtime.message };
  if (!source || !filter) return { tone: 'pending', text: '正在准备全画面美颜…' };
  if (busy) return { tone: 'pending', text: '正在同步参数…' };
  if (!confirmed || confirmed.sourceName !== source || confirmed.filterName !== filter)
    return { tone: 'pending', text: '正在确认完整画面的美颜参数…' };
  if (!confirmed.enabled) return { tone: 'idle', text: '滤镜已关闭 · 调节不会生效' };
  if (!confirmed.liveMode) return { tone: 'idle', text: '静态测试模式 · 尚未启动实时美颜' };
  if (!runtime) return { tone: 'pending', text: '正在确认美颜运行状态…' };
  if (runtime.phase === 'idle') return { tone: 'pending', text: '正在准备全画面美颜…' };
  if (runtime.sourceName !== source || runtime.filterName !== filter)
    return { tone: 'pending', text: '正在跟随当前画面…' };
  if (runtime.phase === 'starting') return { tone: 'pending', text: '正在启动美颜…' };
  if (runtime.phase === 'waiting') return { tone: 'pending', text: runtime.message };
  if (!confirmed.uniform || beautyRuntimeKeys.some(key => confirmed.values[key] !== values[key]))
    return { tone: 'pending', text: '参数已修改 · 等待 OBS 确认' };
  return { tone: 'ready', text: `参数已送达 · ${runtime.message}` };
}
