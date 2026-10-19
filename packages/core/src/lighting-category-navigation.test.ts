import { expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, serializeLinkProject } from '@tb/schema';
import { editLightingCategoryCommand, mergeMa2AttributesCommand } from './ma2-cue-attributes';
import { lightingCategoryNavigation, updateLightingCategoryNavigationCommand } from './lighting-category-navigation';
import { projectLightingLibrary } from './lighting-library';
import { saveMa2MaterialLibraryCommand } from './ma2-program-import';

it('preserves hidden/common state and custom ordering across classification, save, reopen and undo', () => {
  const result = { directory: { show: 'test', generation: 'g', version: '3.7.0.5', entries: [] }, sequences: [], fixtureUsage: [], errors: [], readAt: new Date().toISOString() };
  let project = saveMa2MaterialLibraryCommand('local', result).execute(createEmptyLinkProject('test'));
  project = mergeMa2AttributesCommand('local', result, [], true).execute(project);
  let items = lightingCategoryNavigation(projectLightingLibrary(project));
  expect(items.find(item => item.id === 'category:attribute:video')).toBeUndefined();
  project = editLightingCategoryCommand('mine', '常用自定义').execute(project);
  project = updateLightingCategoryNavigationCommand('category:mine', { display: 'common' }).execute(project);
  project = updateLightingCategoryNavigationCommand('section:front', { display: 'hidden' }).execute(project);
  const move = updateLightingCategoryNavigationCommand('section:rim', { move: -1 });
  const before = project;
  project = move.execute(project);
  expect(move.undo(before)).toBe(before);
  project = mergeMa2AttributesCommand('local', result, [], true).execute(project);
  const reopened = parseLinkProject(JSON.parse(serializeLinkProject(project)));
  items = lightingCategoryNavigation(projectLightingLibrary(reopened));
  expect(items[0]?.id).toBe('section:rim');
  expect(items.find(item => item.id === 'section:front')?.display).toBe('hidden');
  expect(items.some(item => item.id.includes('attribute:'))).toBe(false);
  expect(items.find(item => item.id === 'category:mine')?.display).toBe('common');
  expect(reopened.ma2MaterialLibrary?.library).toEqual(before.ma2MaterialLibrary?.library);
});

it('retains a renamed category position and removes only its menu reference on deletion', () => {
  let project = editLightingCategoryCommand('mine', '自选').execute(createEmptyLinkProject('test'));
  project = updateLightingCategoryNavigationCommand('category:mine', { move: -1 }).execute(project);
  project = editLightingCategoryCommand('mine', '我常用的').execute(project);
  expect(lightingCategoryNavigation(projectLightingLibrary(project))[2]?.name).toBe('我常用的');
  project = editLightingCategoryCommand('mine', null).execute(project);
  expect(projectLightingLibrary(project).navigation?.some(item => item.id === 'category:mine')).toBe(false);
  expect(() => updateLightingCategoryNavigationCommand('category:mine', { move: 1 }).execute(project)).toThrow('分类已不存在');
});
