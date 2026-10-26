# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: home-to-docs.spec.ts >> home: Docs link lists a changelog guide
- Location: e2e/home-to-docs.spec.ts:3:5

# Error details

```
Error: docs index has no changelog guide

expect(locator).toBeVisible() failed

Locator: getByRole('link', { name: 'Changelog' })
Expected: visible
Timeout: 2000ms
Error: element(s) not found

Call log:
  - docs index has no changelog guide getByRole('link', { name: 'Changelog' }) with timeout 2000ms
  - waiting for getByRole('link', { name: 'Changelog' })

```

```yaml
- banner:
  - link "Tasks":
    - /url: /
  - navigation:
    - link "Pricing":
      - /url: /pricing
    - link "About":
      - /url: /about
    - link "Docs":
      - /url: /docs
  - link "Open app":
    - /url: /home
  - link "Log in":
    - /url: /login
  - link "Sign up":
    - /url: /signup
- main:
  - heading "Documentation" [level=1]
  - list:
    - listitem:
      - link "Quickstart":
        - /url: /docs/getting-started/quickstart
    - listitem:
      - link "Invite your team":
        - /url: /docs/getting-started/invite-your-team
    - listitem:
      - link "Timelines":
        - /url: /docs/projects/timelines
    - listitem:
      - link "Archiving a project":
        - /url: /docs/projects/archiving
- contentinfo:
  - paragraph: © 2026 Tasks, Inc.
  - list:
    - listitem:
      - link "Pricing":
        - /url: /pricing
    - listitem:
      - link "Documentation":
        - /url: /docs
    - listitem:
      - link "GitHub":
        - /url: https://github.com/tasks-app/tasks
- alert: Documentation | Tasks
```

# Test source

```ts
  1 | import { expect, test } from '@playwright/test';
  2 | 
  3 | test('home: Docs link lists a changelog guide', async ({ page }) => {
  4 |   await page.goto('/');
  5 |   await page.getByRole('navigation').getByRole('link', { name: 'Docs' }).click();
  6 |   await expect(page).toHaveURL(/\/docs$/);
> 7 |   await expect(page.getByRole('link', { name: 'Changelog' }), 'docs index has no changelog guide').toBeVisible({ timeout: 2000 });
    |                                                                                                    ^ Error: docs index has no changelog guide
  8 | });
  9 | 
```