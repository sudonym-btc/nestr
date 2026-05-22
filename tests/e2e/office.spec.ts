import { expect, test, type Page } from '@playwright/test'

async function expectOfficeCanvasMounted(page: Page) {
  const officeCanvas = page.getByTestId('office-canvas')
  await expect(officeCanvas).toBeVisible()
  await expect
    .poll(
      async () =>
        officeCanvas.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return rect.width > 200 && rect.height > 200 && Boolean(element.querySelector('canvas'))
        }),
      { timeout: 10_000 },
    )
    .toBe(true)
  await page.waitForTimeout(600)
}

test('renders the chatroom office and sends global chat', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Nestr Design Office' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible()
  await expectOfficeCanvasMounted(page)

  await page.getByRole('textbox', { name: 'Message' }).fill('hello from playwright')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('hello from playwright')).toBeVisible()

  const startCall = page.getByRole('button', { name: 'Start call' })
  await expect(startCall).toBeEnabled()
  await startCall.dispatchEvent('click')
  await expect(page.getByLabel('Mock call')).toBeVisible()
  await expect(page.getByText('mock peer stream').first()).toBeVisible()
  await expect(page.getByText(/local camera|camera blocked|requesting camera/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fullscreen call' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disable camera' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mute microphone' })).toBeVisible()
  await expect(page.getByRole('button', { name: /screen share/i })).toBeVisible()
})

test('uses launch params to choose relay directory or group map', async ({ page }) => {
  await page.goto('/?relay=groups.0xchat.com')

  await expect(page.getByRole('heading', { name: 'groups.0xchat.com' }).first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'Relay chats' })).toBeVisible()
  await expect(page.locator('canvas')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Nostr sign in' })).toHaveCount(0)
  await expect(page.getByLabel('Nostr auth')).toHaveCount(0)

  await page.getByRole('button', { name: 'Direct messages' }).click()
  await expect(page.getByRole('dialog', { name: 'Nostr sign in' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Unlock direct messages' })).toBeVisible()

  await page.goto('/?c=0bdfff7a01de485de1343b83ec11b0d66d92e4d75e8c5851a05dab288be4f0aa&relay=groups.0xchat.com')

  await expect(page.getByLabel('Spatial office')).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible()
})

test('filters relay group chats', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Relay relay.nestr.local' }).click()

  const relayDirectory = page.getByRole('region', { name: 'Relay chats' })
  const search = relayDirectory.getByRole('searchbox', { name: 'Search relay groups' })

  await expect(relayDirectory.getByText('Nestr Design Office')).toBeVisible()
  await search.fill('design')
  await expect(relayDirectory.getByText('Nestr Design Office')).toBeVisible()
  await search.fill('no matching group')
  await expect(relayDirectory.getByText('No groups match that search.')).toBeVisible()
})

test('completes browser sign-in from an auth-gated live action', async ({ page }) => {
  const pubkey = 'a'.repeat(64)
  await page.addInitScript((injectedPubkey) => {
    window.nostr = {
      getPublicKey: async () => injectedPubkey,
      signEvent: async (event) => ({
        ...event,
        id: 'b'.repeat(64),
        pubkey: injectedPubkey,
        sig: 'c'.repeat(128),
      }),
      nip44: {
        encrypt: async (_pubkey, plaintext) => plaintext,
        decrypt: async (_pubkey, ciphertext) => ciphertext,
      },
    }
  }, pubkey)

  await page.goto('/?relay=groups.0xchat.com')
  await page.getByRole('button', { name: 'Direct messages' }).click()

  await expect(page.getByLabel('Signer status')).toContainText('signed in')
  await expect(page.getByRole('dialog', { name: 'Nostr sign in' })).toHaveCount(0)
})
