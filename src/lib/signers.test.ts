import { describe, expect, it } from 'vitest'
import { createNostrConnectURI } from 'nostr-tools/nip46'
import { nostrConnectAppMetadata } from './signers'

describe('Nostr Connect metadata', () => {
  it('adds app name, site hint, and favicon logo to the connect URI', () => {
    const metadata = nostrConnectAppMetadata('https://nestr.example')
    const uri = createNostrConnectURI({
      clientPubkey: 'a'.repeat(64),
      relays: ['wss://relay.example'],
      secret: 'connect-secret',
      perms: ['get_public_key'],
      ...metadata,
    })
    const parsed = new URL(uri)

    expect(parsed.searchParams.get('name')).toBe('Nestr')
    expect(parsed.searchParams.get('url')).toBe('https://nestr.example')
    expect(parsed.searchParams.get('image')).toBe('https://nestr.example/favicon.svg')
  })
})
