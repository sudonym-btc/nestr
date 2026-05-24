import { describe, expect, it } from 'vitest'
import {
  discoveredNip29RelayFromEvent,
  mergeDiscoveredNip29Relays,
  NIP66_RELAY_DISCOVERY_KIND,
} from './nip29RelayDiscovery'
import type { NestrEvent } from './nostr'

function discoveryEvent(tags: string[][], content = '{}', createdAt = 100): NestrEvent {
  return {
    id: `${createdAt}`,
    sig: 'sig',
    pubkey: 'a'.repeat(64),
    kind: NIP66_RELAY_DISCOVERY_KIND,
    created_at: createdAt,
    tags,
    content,
  }
}

describe('NIP-29 relay discovery', () => {
  it('parses NIP-66 relay discovery events that advertise NIP-29', () => {
    const relay = discoveredNip29RelayFromEvent(
      discoveryEvent(
        [
          ['d', 'wss://groups.example/'],
          ['N', '29'],
          ['rtt-read', '42'],
          ['R', '!payment'],
          ['R', 'auth'],
        ],
        JSON.stringify({
          name: 'Example Groups',
          description: 'Relay-hosted rooms',
          icon: 'https://example.test/icon.png',
        }),
      ),
    )

    expect(relay).toMatchObject({
      url: 'wss://groups.example',
      name: 'Example Groups',
      description: 'Relay-hosted rooms',
      icon: 'https://example.test/icon.png',
      rttRead: 42,
      requiresAuth: true,
      requiresPayment: false,
    })
  })

  it('uses NIP-11 supported_nips content when N tags are missing', () => {
    expect(
      discoveredNip29RelayFromEvent(
        discoveryEvent(
          [['d', 'wss://content.example']],
          JSON.stringify({ supported_nips: [1, 11, 29] }),
        ),
      )?.url,
    ).toBe('wss://content.example')
  })

  it('ignores relays that do not advertise NIP-29', () => {
    expect(discoveredNip29RelayFromEvent(discoveryEvent([['d', 'wss://notes.example'], ['N', '1']]))).toBeNull()
  })

  it('deduplicates relay URLs and keeps newest metadata', () => {
    const relays = mergeDiscoveredNip29Relays([
      discoveryEvent([['d', 'wss://groups.example/room-one'], ['N', '29']], JSON.stringify({ name: 'Old' }), 100),
      discoveryEvent([['d', 'wss://groups.example/room-two'], ['N', '29']], JSON.stringify({ name: 'New' }), 200),
    ])

    expect(relays).toHaveLength(1)
    expect(relays[0]).toMatchObject({
      url: 'wss://groups.example',
      name: 'New',
      monitorCount: 2,
    })
  })
})
