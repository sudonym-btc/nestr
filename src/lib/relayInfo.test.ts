import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { faviconFor, fetchRelayInfo, relayIconCandidates, relayInfoHttpUrl } from './relayInfo'

describe('relay info', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps websocket relay URLs to their NIP-11 HTTP URL', () => {
    expect(relayInfoHttpUrl('wss://relay.example/path')).toBe('https://relay.example/path')
    expect(relayInfoHttpUrl('ws://relay.example')).toBe('http://relay.example')
    expect(faviconFor('wss://relay.example/path')).toBe('https://relay.example/favicon.ico')
  })

  it('fetches and caches relay icon metadata', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'Relay Example',
        description: 'A relay',
        icon: '/relay.png',
        pubkey: 'A'.repeat(64),
      }),
    })
    vi.stubGlobal('fetch', fetch)

    const first = await fetchRelayInfo('wss://relay.example')
    const second = await fetchRelayInfo('wss://relay.example/')

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      'https://relay.example',
      expect.objectContaining({
        headers: { Accept: 'application/nostr+json' },
      }),
    )
    expect(first).toMatchObject({
      name: 'Relay Example',
      description: 'A relay',
      icon: 'https://relay.example/relay.png',
      pubkey: 'a'.repeat(64),
    })
    expect(second).toMatchObject({ name: 'Relay Example' })
  })

  it('uses explicit NIP-11 relay icons without noisy favicon probing', () => {
    expect(relayIconCandidates('wss://groups.0xchat.com', {
      name: '0xchat',
      icon: 'https://cdn.example/logo.png',
      fetchedAt: 1,
    })).toEqual(['https://cdn.example/logo.png'])
    expect(relayIconCandidates('wss://groups.0xchat.com', null)).toEqual([])
  })
})
