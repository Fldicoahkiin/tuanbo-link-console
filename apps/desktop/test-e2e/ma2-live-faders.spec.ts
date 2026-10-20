import { test, expect } from '@playwright/test';
import type { Ma2ExecutorInput } from '@tb/schema';
import { launchExecutorFixture } from './ma2-executor-fixture';

test('中层显示紧凑执行器按键，沿既有连接读回改名，不建立竖推杆通道', async ({}, info) => {
  test.setTimeout(90000);
  const { app, page, errors } = await launchExecutorFixture(info);
  try {
    const fader = page.locator('[data-executor-band="fader"]');
    await expect(fader.getByRole('button', { name: '执行器 100.1 · 面光_Long_Sequence_Name', exact: true })).toBeVisible();
    await expect(fader.locator('[data-executor-slot]')).toHaveCount(15);
    await expect(fader.locator('input[type="range"]')).toHaveCount(0);
    await expect(fader.locator('input[type="password"]')).toHaveCount(0);
    await app.evaluate(() => { process.env.TBLINK_EXECUTOR_REMOTE_NAME = '控台改名面光'; });
    await expect(fader.getByRole('button', { name: '执行器 100.1 · 控台改名面光', exact: true })).toBeVisible();
    await fader.getByRole('button', { name: '执行器 100.1 · 控台改名面光', exact: true }).click();
    await expect.poll(async () => (JSON.parse(await app.evaluate(() => process.env.TBLINK_EXECUTOR_INPUTS ?? '[]')) as Ma2ExecutorInput[]).filter(value => value.pressed)).toHaveLength(1);
    const inputs = JSON.parse(await app.evaluate(() => process.env.TBLINK_EXECUTOR_INPUTS ?? '[]')) as Ma2ExecutorInput[];
    expect(inputs[0]).toMatchObject({ page: 100, slot: 1, button: 0, pressed: true });
    expect(inputs[0]!.expectedItem.buttons).toEqual([12299, 12302, 12290, 0]);
    expect(await app.evaluate(() => process.env.TBLINK_EXECUTOR_ACTIONS)).toBe('[]');
    const flash = fader.getByRole('button', { name: '执行器 100.1 Flash', exact: true });
    await flash.focus(); await page.keyboard.down('Space');
    await expect.poll(async () => (JSON.parse(await app.evaluate(() => process.env.TBLINK_EXECUTOR_INPUTS ?? '[]')) as Ma2ExecutorInput[]).some(value => value.button === 1 && value.pressed)).toBe(true);
    await expect(flash).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.up('Space');
    await expect.poll(async () => (JSON.parse(await app.evaluate(() => process.env.TBLINK_EXECUTOR_INPUTS ?? '[]')) as Ma2ExecutorInput[]).some(value => value.button === 1 && !value.pressed)).toBe(true);
    await expect(flash).toHaveAttribute('aria-pressed', 'false');
    await flash.focus(); await page.keyboard.down('Space');
    await expect(flash).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect.poll(() => app.evaluate(() => Number(process.env.TBLINK_EXECUTOR_RELEASES))).toBeGreaterThan(0);
    await page.keyboard.up('Space');
    await expect(flash).toHaveAttribute('aria-pressed', 'false');
    expect(await app.evaluate(() => process.env.TBLINK_EXECUTOR_LIVE_CALLS)).toBe('0');
    await page.screenshot({ path: info.outputPath('executor-middle-compact.png') });
    expect(errors).toEqual([]);
  } finally { await page.evaluate(() => window.tbLink.setDocumentDirty(false)); await app.close(); }
});
