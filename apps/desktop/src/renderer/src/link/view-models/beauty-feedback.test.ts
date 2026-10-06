import { expect, it } from 'vitest';
import { neutralBeautyValues, type BeautyFilterState, type BeautyRuntimeState } from '@tb/schema';
import { beautyFeedback } from './beauty-feedback';

const confirmed: BeautyFilterState = { sourceName: '机位 A', filterName: '美颜', enabled: true, liveMode: true,
  uniform: true, values: { ...neutralBeautyValues } };
const runtime: BeautyRuntimeState = { phase: 'tracking', sourceName: '机位 A', filterName: '美颜', faces: 2, message: '面部 2 人 · 美体 1 人' };
const input = { connected: true, source: '机位 A', filter: '美颜', confirmed, values: { ...neutralBeautyValues },
  busy: false, error: null, runtime, runtimeError: '' };

it('只有同一来源参数回读一致且实时分析有效才显示送达', () => {
  expect(beautyFeedback(input)).toEqual({ tone: 'ready', text: '参数已送达 · 面部 2 人 · 美体 1 人' });
  expect(beautyFeedback({ ...input, values: { ...input.values, slim: 20 } }).tone).toBe('pending');
  expect(beautyFeedback({ ...input, confirmed: { ...confirmed, uniform: false } }).tone).toBe('pending');
  expect(beautyFeedback({ ...input, runtime: { ...runtime, sourceName: '机位 B' } }).tone).toBe('pending');
  expect(beautyFeedback({ ...input, confirmed: { ...confirmed, sourceName: '机位 B' } }).tone).toBe('pending');
});

it('断线、禁用、静态、停止、等待和读取失败均撤下生效状态', () => {
  expect(beautyFeedback({ ...input, connected: false }).tone).toBe('idle');
  expect(beautyFeedback({ ...input, confirmed: { ...confirmed, enabled: false } }).tone).toBe('idle');
  expect(beautyFeedback({ ...input, confirmed: { ...confirmed, liveMode: false } }).tone).toBe('idle');
  expect(beautyFeedback({ ...input, runtime: { ...runtime, phase: 'idle' } }).tone).toBe('pending');
  expect(beautyFeedback({ ...input, runtime: { ...runtime, phase: 'waiting', message: '等待有效人像' } })).toEqual({ tone: 'pending', text: '等待有效人像' });
  expect(beautyFeedback({ ...input, runtimeError: '状态读取失败' })).toEqual({ tone: 'error', text: '状态读取失败' });
  expect(beautyFeedback({ ...input, error: 'OBS 请求超时' })).toEqual({ tone: 'error', text: 'OBS 请求超时' });
  expect(beautyFeedback({ ...input, runtime: { ...runtime, phase: 'error', message: '分析器已退出' } })).toEqual({ tone: 'error', text: '分析器已退出' });
});
