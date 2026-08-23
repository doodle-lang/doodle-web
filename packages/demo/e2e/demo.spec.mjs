// Browser smoke test for the demo page (served as the built static app via `vite
// preview`, so the real CSP-clean bundle runs). Verifies the end-to-end DOM wiring the
// Node run-core tests can't: the CodeMirror editor mounts, Run drives the engine and draws
// on the real canvas, and Stop halts a long/looping program.

import { test, expect } from '@playwright/test';

/** True if the canvas has any non-background (non-white, opaque) pixel — i.e. something drew. */
async function canvasHasDrawing(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      // non-white opaque pixel
      if (data[i + 3] > 0 && (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250)) return true;
    }
    return false;
  });
}

test('the editor mounts with the starter program', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect(page.locator('#editor')).toContainText('forward');
});

test('Run draws the turtle path and reports done', async ({ page }) => {
  await page.goto('/');
  await expect(canvasHasDrawing(page)).resolves.toBe(false); // blank before running
  await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('done', { timeout: 20_000 });
  await expect(canvasHasDrawing(page)).resolves.toBe(true);
  await expect(page.locator('#output')).toContainText('done');
});

test('the page loads and runs with no console errors (CSP-clean)', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('done', { timeout: 20_000 });
  // No CSP violations (e.g. a style-src too strict for CodeMirror's injected styles) or
  // other page errors.
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the executing line is highlighted while running', async ({ page }) => {
  await page.goto('/');
  await page.locator('#run').click();
  // The exec-line highlight tracks the running program (and clears when it finishes).
  await expect(page.locator('.cm-execLine')).toBeVisible({ timeout: 10_000 });
});

test('Stop halts a running program mid-draw', async ({ page }) => {
  await page.goto('/');
  // The starter spiral animates for several seconds — click Run, then Stop while it's still
  // running. The run ends `stopped` (Faulted(Cancelled)), never reaching `done`.
  await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('running…');
  await expect(page.locator('#stop')).toBeEnabled();
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toHaveText('stopped', { timeout: 20_000 });
});
