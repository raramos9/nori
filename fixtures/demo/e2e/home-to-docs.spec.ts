import { expect, test } from '@playwright/test';

test('home: Docs link lists a changelog guide', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('link', { name: 'Docs' }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await expect(page.getByRole('link', { name: 'Changelog' }), 'docs index has no changelog guide').toBeVisible({ timeout: 2000 });
});
