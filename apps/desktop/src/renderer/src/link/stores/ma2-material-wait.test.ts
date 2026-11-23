import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2CatalogRequest, type Ma2EffectLibrary, type Ma2ReadProgressUpdate } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { useShowStateStore } from './show-state-store';
import { scanMa2Materials, useMa2MaterialReadStore } from './ma2-material-read-store';

vi.mock('../project-document', () => ({ requireProjectLocation: () => Promise.resolve('test.tblink') }));
afterEach(() => { vi.unstubAllGlobals(); useShowStateStore.setState({ show: { phase: 'idle', program: null } }); });

it('停止中的素材读取保留已经读完的序列，空闲后只读余下的序列', async () => {
  const directory = { show: 'Test', version: '3.7', generation: 'g1', entries: [{ target: 1, name: 'one' }, { target: 2, name: 'two' }] };
  const readAt = new Date().toISOString();
  const first = { sequence: 1, name: 'one', cues: [] };
  const second = { sequence: 2, name: 'two', cues: [] };
  const read = vi.fn<(request: Ma2CatalogRequest, update: (value: Ma2ReadProgressUpdate) => void) => Promise<Ma2EffectLibrary>>()
    .mockImplementationOnce((_request, update) => {
      update({ phase: 'library', completed: 1, total: 3, detail: '读取中', checkpoint: { directory, readAt }, sequences: [first] });
      useShowStateStore.setState({ show: { phase: 'stopping', source: 'internal', itemId: null, program: null } });
      return Promise.reject(new Error('节目在停止，停下以后再读取控台。'));
    })
    .mockResolvedValueOnce({ directory, readAt, sequences: [second], fixtureUsage: [], errors: [] });
  vi.stubGlobal('window', { tbLink: { readMa2EffectLibrary: read } });
  useDocumentStore.getState().setProject(createEmptyLinkProject('测试素材'), 'test.tblink');
  const source = { dataDirectory: '', network: { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'test' } };
  const result = scanMa2Materials(source);
  await vi.waitFor(() => expect(useMa2MaterialReadStore.getState().waiting).toBe(true));
  expect(useMa2MaterialReadStore.getState().error).toBe('');
  expect(scanMa2Materials(source)).toBe(result);
  expect(read).toHaveBeenCalledTimes(1);
  useShowStateStore.setState({ show: { phase: 'idle', program: null } });
  await result;
  expect(read.mock.calls[1]?.[0].targets).toEqual([2]);
  expect(useDocumentStore.getState().project?.ma2MaterialLibrary?.library?.sequences.map(s => s.sequence)).toEqual([1, 2]);
  expect(useMa2MaterialReadStore.getState()).toMatchObject({ busy: false, waiting: false, error: '' });
});
