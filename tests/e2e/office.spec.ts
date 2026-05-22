import { expect, test } from '@playwright/test'

test('renders the NIP-29 office and sends global chat', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Nestr Design Office' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'NIP-29 chat' })).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible()

  await page.getByRole('textbox', { name: 'Message' }).fill('hello from playwright')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('hello from playwright')).toBeVisible()

  await page.getByRole('button', { name: 'Start call' }).click()
  await expect(page.getByLabel('Mock WebRTC call')).toBeVisible()
  await expect(page.getByText('mock peer stream').first()).toBeVisible()
  await expect(page.getByText(/local camera|camera blocked/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fullscreen call' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disable camera' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mute microphone' })).toBeVisible()

  await page.screenshot({ path: 'test-results/nestr-office.png', fullPage: true })
})
