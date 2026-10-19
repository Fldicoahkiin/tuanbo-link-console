import type { LightingUserLibrary } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { projectLightingLibrary, setLightingLibraryCommand } from './lighting-library';

type Display = NonNullable<LightingUserLibrary['navigation']>[number]['display'];
type Section = 'front' | 'rim' | 'effect';
export type LightingCategoryMenuItem = { id: string; name: string; display: Display } & ({ kind: 'section'; section: Section } | { kind: 'category'; categoryId: string });

/** Resolve saved menu order without removing the underlying categories or cue assignments. */
export function lightingCategoryNavigation(library: LightingUserLibrary): LightingCategoryMenuItem[] {
  const items: LightingCategoryMenuItem[] = [
    { id: 'section:front', name: '面光', display: 'common', kind: 'section', section: 'front' },
    { id: 'section:rim', name: '轮廓', display: 'common', kind: 'section', section: 'rim' },
    { id: 'section:effect', name: '效果', display: 'common', kind: 'section', section: 'effect' },
    ...library.categories.filter(category => category.custom && !category.id.startsWith('attribute:')).map((category): LightingCategoryMenuItem => ({
      id: `category:${category.id}`, name: category.name, display: 'common', kind: 'category', categoryId: category.id
    }))
  ];
  const remaining = new Map(items.map(item => [item.id, item]));
  const ordered: LightingCategoryMenuItem[] = [];
  for (const saved of library.navigation ?? []) {
    const item = remaining.get(saved.id);
    if (item) { ordered.push({ ...item, display: saved.display }); remaining.delete(saved.id); }
  }
  return [...ordered, ...remaining.values()];
}

export function updateLightingCategoryNavigationCommand(id: string, change: { display: Display } | { move: -1 | 1 }): LinkCommand {
  return { id: crypto.randomUUID(), label: '调整灯光分类菜单', scope: 'lighting', execute(project) {
    const library = projectLightingLibrary(project);
    const items = lightingCategoryNavigation(library).map(({ id, display }) => ({ id, display }));
    const index = items.findIndex(item => item.id === id);
    if (index < 0) throw new Error('分类已不存在');
    if ('display' in change) items[index] = { id, display: change.display };
    else {
      const target = index + change.move;
      if (target >= 0 && target < items.length) [items[index], items[target]] = [items[target]!, items[index]!];
    }
    return setLightingLibraryCommand({ ...library, navigation: items }).execute(project);
  }, undo: before => before };
}
