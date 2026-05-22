import { expect, test } from '@playwright/test'

test('renders the NIP-29 office and sends global chat', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Nestr Design Office' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'NIP-29 chat' })).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible()

  await page.getByRole('textbox', { name: 'Message' }).fill('hello from playwright')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('hello from playwright')).toBeVisible()

  await page.screenshot({ path: 'test-results/nestr-office.png', fullPage: true })
})
