import { expect, it } from 'vitest';
import { obsWebSocketUrlSchema } from './obs-address';

it.each([
  ['4455', 'ws://127.0.0.1:4455'],
  [' 4567 ', 'ws://127.0.0.1:4567'],
  ['127.0.0.1', 'ws://127.0.0.1:4455'],
  ['127.0.0.1:4455', 'ws://127.0.0.1:4455'],
  [' ws://127.0.0.1 ', 'ws://127.0.0.1:4455'],
  ['ws://192.168.1.2', 'ws://192.168.1.2:4455'],
  ['localhost:4567', 'ws://localhost:4567'],
  ['ws://localhost:80', 'ws://localhost:80'],
  ['ws://[::1]', 'ws://[::1]:4455'],
  ['ws://localhost:4567/obs', 'ws://localhost:4567/obs'],
  ['wss://example.com/obs', 'wss://example.com/obs'],
  ['wss://example.com:443', 'wss://example.com:443']
])('OBS 地址 %s 规范化且重复保存稳定', (input, expected) => {
  expect(obsWebSocketUrlSchema.parse(input)).toBe(expected);
  expect(obsWebSocketUrlSchema.parse(expected)).toBe(expected);
});

it.each(['', 'http://localhost:4455', 'ws://localhost:99999', 'ws://name:secret@localhost:4455', 'ws://localhost:4455#fragment'])('错误地址 %s 阻断保存', input => {
  expect(obsWebSocketUrlSchema.safeParse(input).success).toBe(false);
});
