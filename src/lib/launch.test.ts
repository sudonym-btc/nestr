import { describe, expect, it } from 'vitest'
import { normalizeRelayUrl, parseLaunch } from './launch'

describe('launch URL parsing', () => {
  it('uses the relay picker without group and relay params', () => {
    expect(parseLaunch('')).toEqual({ mode: 'landing' })
  })

  it('uses a persistent development relay for nestr development hosts', () => {
    expect(parseLaunch('?relay=relay.nestr.development')).toEqual({
      mode: 'mock',
      groupId: undefined,
      relayUrl: 'wss://relay.nestr.development',
      authRequired: true,
      initialView: 'relay',
    })
    expect(parseLaunch('?c=abc123&relay=openrelay.nestr.development')).toEqual({
      mode: 'mock',
      groupId: 'abc123',
      relayUrl: 'wss://openrelay.nestr.development',
      authRequired: false,
      initialView: 'group',
    })
  })

  it('switches to live NIP-29 mode from obelisk-style params', () => {
    expect(parseLaunch('?c=abc123&relay=groups.0xchat.com')).toEqual({
      mode: 'live',
      groupId: 'abc123',
      relayUrl: 'wss://groups.0xchat.com',
      nostrConnectRelays: [],
      initialView: 'group',
    })
  })

  it('opens a relay directory when only the relay param is present', () => {
    expect(parseLaunch('?relay=groups.0xchat.com')).toEqual({
      mode: 'live',
      groupId: undefined,
      relayUrl: 'wss://groups.0xchat.com',
      nostrConnectRelays: [],
      initialView: 'relay',
    })
  })

  it('normalizes HTTP relay hints to WebSocket URLs', () => {
    expect(normalizeRelayUrl('https://relay.example/')).toBe('wss://relay.example')
  })

  it('keeps explicit Nostr Connect relays separate from the room relay', () => {
    expect(parseLaunch('?c=abc123&relay=groups.0xchat.com&connectRelay=relay.nsec.app,https://relay.example/')).toEqual({
      mode: 'live',
      groupId: 'abc123',
      relayUrl: 'wss://groups.0xchat.com',
      nostrConnectRelays: ['wss://relay.nsec.app', 'wss://relay.example'],
      initialView: 'group',
    })
  })
})
