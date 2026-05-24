import { describe, expect, it } from 'vitest'
import { createNostrConnectURI, type BunkerPointer } from 'nostr-tools/nip46'
import {
  DEFAULT_NOSTR_CONNECT_RELAYS,
  NESTR_NIP46_PERMISSIONS,
  normalizeStoredNostrConnectSession,
  nostrConnectAppMetadata,
  nostrConnectRelayHints,
  nostrConnectStoredRelayHints,
} from './signers'

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

  it('requests signing permissions for NIP-29 group management events', () => {
    expect(NESTR_NIP46_PERMISSIONS).toEqual(
      expect.arrayContaining([
        'ping',
        'sign_event:9000',
        'sign_event:9001',
        'sign_event:9002',
        'sign_event:9005',
        'sign_event:9007',
        'sign_event:9008',
        'sign_event:9009',
        'sign_event:9021',
        'sign_event:9022',
      ]),
    )
  })

  it('uses relay.nsec.app only for NIP-46 by default', () => {
    expect(nostrConnectRelayHints('wss://groups.0xchat.com')).toEqual([
      'wss://relay.nsec.app',
    ])
    expect(DEFAULT_NOSTR_CONNECT_RELAYS).toEqual(['wss://relay.nsec.app'])
  })

  it('uses explicit NIP-46 relay hints without adding defaults', () => {
    expect(nostrConnectRelayHints('wss://groups.0xchat.com', ['relay.nsec.app'])).toEqual([
      'wss://relay.nsec.app',
    ])
  })

  it('backfills stored Nostr Connect sessions with relay hints for restore', () => {
    const normalized = normalizeStoredNostrConnectSession({
      version: 1,
      clientSecretKey: '0'.repeat(64),
      bunkerPointer: {
        pubkey: 'a'.repeat(64),
        secret: null,
      } as BunkerPointer,
      userPubkey: 'b'.repeat(64),
      relayUrl: 'https://relay.nsec.app/',
      connectedAt: 1,
    })

    expect(normalized.relayUrl).toBe('wss://relay.nsec.app')
    expect(normalized.relayUrls).toEqual(['wss://relay.nsec.app'])
    expect(normalized.bunkerPointer.relays).toEqual(['wss://relay.nsec.app'])
  })

  it('deduplicates stored Nostr Connect relay hints across legacy fields', () => {
    expect(
      nostrConnectStoredRelayHints({
        version: 1,
        clientSecretKey: '0'.repeat(64),
        bunkerPointer: {
          pubkey: 'a'.repeat(64),
          relays: ['https://relay.nsec.app/', 'relay2.example'],
          secret: null,
        },
        userPubkey: 'b'.repeat(64),
        relayUrl: 'relay.nsec.app',
        relayUrls: ['wss://relay.nsec.app'],
        connectedAt: 1,
      }),
    ).toEqual(['wss://relay.nsec.app', 'wss://relay2.example'])
  })
})
