import { expect, test } from '@playwright/test';

test('pricing: Get started opens the signup form', async ({ page }) => {
  await page.goto('/pricing');
  await page.getByRole('link', { name: 'Get started' }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
});
