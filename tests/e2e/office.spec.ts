import { expect, test, type Locator, type Page } from '@playwright/test'

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
      { timeout: 30_000 },
    )
    .toBe(true)
  await page.waitForTimeout(600)
}

async function fillReactInput(locator: Locator, value: string) {
  await locator.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement
    const previousValue = input.value
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, nextValue)
    ;(input as HTMLInputElement & { _valueTracker?: { setValue: (value: string) => void } })._valueTracker?.setValue(previousValue)
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: nextValue, inputType: 'insertText' }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

async function submitComposer(locator: Locator) {
  await locator.evaluate((element) => {
    ;(element as HTMLFormElement).requestSubmit()
  })
}

test('renders the chatroom office and sends global chat', async ({ page }) => {
  await page.goto('/?relay=openrelay.nestr.development&c=product-floor')

  await expect(page.getByRole('heading', { name: 'Nestr Design Office' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible()
  await expectOfficeCanvasMounted(page)

  await fillReactInput(page.getByRole('textbox', { name: 'Message' }), 'hello from playwright')
  await submitComposer(page.locator('.chat-panel form.composer'))
  await expect(page.getByText('hello from playwright')).toBeVisible()

  await page.locator('.chat-panel input[type="file"]').setInputFiles({
    name: 'hello.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('attached hello'),
  })
  await expect(page.getByText('hello.txt')).toBeVisible()
  await submitComposer(page.locator('.chat-panel form.composer'))
  await expect(page.getByRole('button', { name: 'Download hello.txt' })).toBeVisible()

  await page.getByRole('button', { name: 'Account' }).dispatchEvent('click')
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible()
  await expect(page.getByText(/dm relays/i)).toBeVisible()
  await expect(page.getByText(/file servers/i)).toBeVisible()
  await page.keyboard.press('Escape')

  await expect(page.getByLabel('Mock call')).toBeVisible()
  await expect(page.getByText('mock peer stream').first()).toBeVisible()
  await expect(page.getByText(/local camera|camera blocked|requesting camera/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fullscreen call' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disable camera' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mute microphone' })).toBeVisible()
  await expect(page.getByRole('button', { name: /screen share/i })).toBeVisible()
})

test('uses launch params to choose relay directory or group map', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Choose a relay' })).toBeVisible()
  await expect(page.getByText('openrelay.nestr.development')).toBeVisible()

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
  await page.goto('/?relay=openrelay.nestr.development')

  const relayDirectory = page.getByRole('region', { name: 'Relay chats' })
  const search = relayDirectory.getByRole('searchbox', { name: 'Search relay groups' })

  await expect(relayDirectory.getByText('Nestr Design Office')).toBeVisible()
  await search.fill('design')
  await expect(relayDirectory.getByText('Nestr Design Office')).toBeVisible()
  await search.fill('no matching group')
  await expect(relayDirectory.getByText('No groups match that search.')).toBeVisible()
})

test.describe('WebGL viewport sizing', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1180, height: 760 } })

  test('keeps the office canvas fitted to the panel at retina scale', async ({ page }) => {
    for (const viewport of [
      { width: 1180, height: 760 },
      { width: 430, height: 860 },
    ]) {
      await page.setViewportSize(viewport)
      await page.goto('/?relay=openrelay.nestr.development&c=product-floor')
      await expectOfficeCanvasMounted(page)

      const sizing = await page.getByTestId('office-canvas').evaluate((host) => {
        const canvas = host.querySelector('[data-testid="office-webgl-canvas"]') as HTMLCanvasElement | null
        const hostRect = host.getBoundingClientRect()
        const canvasRect = canvas?.getBoundingClientRect()
        return {
          dpr: window.devicePixelRatio,
          hostWidth: hostRect.width,
          hostHeight: hostRect.height,
          canvasWidth: canvasRect?.width ?? 0,
          canvasHeight: canvasRect?.height ?? 0,
          backingWidth: canvas?.width ?? 0,
          backingHeight: canvas?.height ?? 0,
        }
      })

      expect(Math.abs(sizing.canvasWidth - sizing.hostWidth)).toBeLessThan(1)
      expect(Math.abs(sizing.canvasHeight - sizing.hostHeight)).toBeLessThan(1)
      expect(sizing.backingWidth).toBeGreaterThanOrEqual(Math.floor(sizing.canvasWidth * sizing.dpr) - 2)
      expect(sizing.backingHeight).toBeGreaterThanOrEqual(Math.floor(sizing.canvasHeight * sizing.dpr) - 2)
    }
  })
})

test('opens a newly created chatroom immediately', async ({ page }) => {
  await page.goto('/?relay=openrelay.nestr.development&c=product-floor')

  await page.getByRole('button', { name: 'Create chatroom' }).click({ force: true })
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  const generatedGroupId = await dialog.getByRole('textbox', { name: 'New chatroom id' }).inputValue()
  await submitComposer(dialog.locator('form'))

  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: generatedGroupId })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
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
