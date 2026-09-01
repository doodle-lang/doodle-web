// Browser smoke test for the M6.9 debugger UI (served as the built static app). Verifies the
// DOM wiring the Node debug-core tests can't: a gutter click sets a breakpoint, Debug drives the
// engine to it and pauses, the panels render a variable, and Stop ends the session — plus that
// Debug with no breakpoint runs to completion.

import { test, expect } from '@playwright/test';

/** Clicks the breakpoint gutter beside the first line containing `text` (gutter x, line y). */
async function toggleBreakpointAt(page, text) {
  const line = page.locator('.cm-line', { hasText: text }).first();
  await line.scrollIntoViewIfNeeded();
  const lineBox = await line.boundingBox();
  const gutterBox = await page.locator('.cm-breakpoint-gutter').boundingBox();
  await page.mouse.click(gutterBox.x + gutterBox.width / 2, lineBox.y + lineBox.height / 2);
}

test('a gutter breakpoint pauses Debug and shows a variable', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.cm-editor')).toBeVisible();

  await toggleBreakpointAt(page, 'forward(side)');
  await expect(page.locator('.cm-breakpoint-dot')).toBeVisible();

  // Debug drives to the breakpoint (the first loop iteration) and pauses before `forward`.
  await page.locator('#debug').click();
  await expect(page.locator('#status')).toContainText('paused', { timeout: 20_000 });
  await expect(page.locator('#debug-panels')).toBeVisible();
  await expect(page.locator('#debug-panels')).toContainText('side');
  await expect(page.locator('#continue')).toBeEnabled();

  // Stop ends the debug session.
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toHaveText('stopped', { timeout: 20_000 });
});

test('Debug with no breakpoint runs the program to completion', async ({ page }) => {
  await page.goto('/');
  await page.locator('#debug').click();
  await expect(page.locator('#status')).toHaveText('done', { timeout: 20_000 });
});

test('stepping past a breakpoint advances the paused line', async ({ page }) => {
  await page.goto('/');
  await toggleBreakpointAt(page, 'let side = 5');
  await expect(page.locator('.cm-breakpoint-dot')).toBeVisible();

  await page.locator('#debug').click();
  await expect(page.locator('#status')).toContainText('paused', { timeout: 20_000 });
  const firstLine = await page.locator('.cm-execLine').textContent();
  await page.locator('#step').click();
  // After a step the paused (highlighted) line moves off the breakpoint line.
  await expect(page.locator('.cm-execLine')).not.toHaveText(firstLine ?? '', { timeout: 10_000 });
  await page.locator('#stop').click();
});
