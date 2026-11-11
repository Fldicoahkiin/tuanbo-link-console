import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, requiredSchemaVersion, serializeLinkProject, type LinkProject } from '@tb/schema';
import { describe, expect, it } from 'vitest';
import { normalizeContentTimeline } from './content-timeline';
import { setLightingCommand } from './lighting-edit';
import { setLightingLibraryViewCommand } from './lighting-library';
import { withSchemaVersion } from './project-schema-version';

// Editor rules from the 0.5.9 editor design. Only rule 6 exists so far; rules 1–5 arrive with the shared beats and waveform steps.

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const view = { section: 'front', tone: 'bright', people: 3, zone: 'front', view: 'music', effectCategory: 'effect:music:0', scope: 'category', query: '' } as const;

function song(project: LinkProject, withLighting: boolean): LinkProject {
  return parseLinkProject({ ...project, rundown: [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], ...(withLighting ? { lighting: createLightingDocument() } : {}) }] });
}
function versioned(schemaVersion: 1 | 2 | 3, withLighting: boolean): LinkProject {
  return song({ ...createEmptyLinkProject('版本'), schemaVersion }, withLighting);
}
/** What a save does to a project: the store normalizes it, the main process serializes it, the next open parses it. */
function saveAndReopen(project: LinkProject): LinkProject {
  return parseLinkProject(JSON.parse(serializeLinkProject(normalizeContentTimeline(project))));
}
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('规则 6：工程格式版本只按用到的内容决定，只升不降', () => {
  it('没有灯光和控台数据要 1；只有灯光或控台数据要 2', () => {
    expect(requiredSchemaVersion(versioned(1, false))).toBe(1);
    expect(requiredSchemaVersion(versioned(2, true))).toBe(2);
    expect(requiredSchemaVersion(versioned(2, false))).toBe(1);
  });

  it('只升不降：灯光命令把 1 升到 2，不会把 3 写回 2，也不会把 2 降成 1', () => {
    expect(setLightingCommand('song', createLightingDocument()).execute(versioned(1, false)).schemaVersion).toBe(2);
    expect(setLightingCommand('song', createLightingDocument()).execute(versioned(3, false)).schemaVersion).toBe(3);
    expect(setLightingLibraryViewCommand(view).execute(versioned(3, false)).schemaVersion).toBe(3);
    expect(setLightingLibraryViewCommand(view).execute(versioned(1, false)).schemaVersion).toBe(2);
    const v2 = versioned(2, false);
    expect(withSchemaVersion(v2)).toBe(v2);
    const v1 = versioned(1, false);
    expect(withSchemaVersion(v1)).toBe(v1);
  });

  it('保存出来的版本永远不低于需要的版本，低了就拒绝保存', () => {
    for (const project of [versioned(1, false), versioned(2, true), versioned(3, true)]) {
      const saved = saveAndReopen(project);
      expect(saved.schemaVersion).toBeGreaterThanOrEqual(requiredSchemaVersion(saved));
    }
    expect(() => serializeLinkProject({ ...versioned(2, true), schemaVersion: 1 })).toThrow('防止旧版本丢失数据');
  });

  it('没用新内容的 v1、v2 工程保存后版本不变，0.5.8 仍能打开', () => {
    expect(saveAndReopen(versioned(1, false)).schemaVersion).toBe(1);
    expect(saveAndReopen(versioned(2, true)).schemaVersion).toBe(2);
    expect(saveAndReopen(versioned(2, false)).schemaVersion).toBe(2);
    // Nothing writes a field that needs 3 yet, so no edit may produce a file 0.5.8 (which accepts 1 and 2) refuses.
    expect(requiredSchemaVersion(saveAndReopen(setLightingCommand('song', createLightingDocument()).execute(versioned(1, false))))).toBe(2);
    expect(saveAndReopen(setLightingCommand('song', createLightingDocument()).execute(versioned(1, false))).schemaVersion).toBe(2);
  });

  it('非测试代码里不手写工程版本号，一律经 withSchemaVersion', () => {
    const roots = ['packages', 'apps'].flatMap(group => readdirSync(join(repoRoot, group), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => join(repoRoot, group, entry.name, 'src')));
    const offenders = roots.flatMap(root => {
      let files: string[];
      try { files = sourceFiles(root); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      }
      return files.flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/)
        .flatMap((line, index) => /schemaVersion\s*[:=]\s*[23]\b/.test(line) ? [`${relative(repoRoot, file).replaceAll('\\', '/')}:${index + 1}`] : []));
    });
    expect(offenders).toEqual([]);
    expect(sourceFiles(join(repoRoot, 'packages/core/src')).length).toBeGreaterThan(10);
  });
});
