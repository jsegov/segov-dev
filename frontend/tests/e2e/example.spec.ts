import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
    await page.goto('/');

    // Expect a title "to contain" a substring.
    // Adjust this expectation based on your actual app title
    await expect(page).toHaveTitle(/Jonathan Segovia \| Portfolio/);
});

test('get started link', async ({ page }) => {
    await page.goto('/');

    // Click the get started link.
    // Adjust this based on your actual app content
    // await page.getByRole('link', { name: 'Get started' }).click();

    // Expects page to have a heading with the name of Installation.
    // await expect(page.getByRole('heading', { name: 'Installation' })).toBeVisible();
});
