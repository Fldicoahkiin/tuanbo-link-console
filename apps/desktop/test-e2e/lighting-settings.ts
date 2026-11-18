import type { Page } from '@playwright/test';

export async function turnOffTimelineAudition(page: Page): Promise<void> {
  const workspaces = page.getByRole('navigation', { name: '主要工作区' });
  await workspaces.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: 'MA2 控台', exact: true }).click();
  await page.getByRole('switch', { name: '时间线选中 Cue 试听' }).uncheck();
  await workspaces.getByRole('button', { name: '灯光工作台', exact: true }).click();
}
