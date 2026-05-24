import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NestrEvent } from './nostr'
import {
  cacheProfileRelayList,
  cacheProfileMetadata,
  clearProfileMetadataCache,
  getCachedProfileRelayList,
  getCachedProfileRelayLists,
  getCachedProfileMetadata,
  getCachedProfileMetadatas,
} from './profileMetadataCache'

function profileEvent(pubkey: string, createdAt: number, content: string): NestrEvent {
  return {
    id: `${pubkey.slice(0, 8)}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 0,
    tags: [],
    content,
    sig: `sig-${createdAt}`,
  }
}

function relayListEvent(pubkey: string, createdAt: number): NestrEvent {
  return {
    id: `${pubkey.slice(0, 8)}-relay-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 10002,
    tags: [['r', 'wss://write.example', 'write']],
    content: '',
    sig: `sig-${createdAt}`,
  }
}

describe('profile metadata cache', () => {
  beforeEach(() => {
    clearProfileMetadataCache()
  })

  it('stores profile metadata for later reads', () => {
    const pubkey = 'a'.repeat(64)
    const event = profileEvent(pubkey, 12, JSON.stringify({ name: 'Alice' }))

    cacheProfileMetadata(event)

    expect(getCachedProfileMetadata(pubkey)).toEqual(event)
    expect(getCachedProfileMetadatas([pubkey])).toEqual([event])
  })

  it('keeps the newest metadata event for a pubkey', () => {
    const pubkey = 'b'.repeat(64)
    const newest = profileEvent(pubkey, 20, JSON.stringify({ name: 'New' }))

    cacheProfileMetadata(newest)
    cacheProfileMetadata(profileEvent(pubkey, 10, JSON.stringify({ name: 'Old' })))

    expect(getCachedProfileMetadata(pubkey)).toEqual(newest)
  })

  it('ignores events that are not kind 0 profile metadata', () => {
    const event = { ...profileEvent('c'.repeat(64), 30, '{}'), kind: 1 }

    cacheProfileMetadata(event)

    expect(getCachedProfileMetadata(event.pubkey)).toBeNull()
  })

  it('stores NIP-65 relay lists for later profile relay lookups', () => {
    const pubkey = 'd'.repeat(64)
    const event = relayListEvent(pubkey, 40)

    cacheProfileRelayList(event)

    expect(getCachedProfileRelayList(pubkey)).toEqual(event)
    expect(getCachedProfileRelayLists([pubkey])).toEqual([event])
  })

  it('keeps the newest relay list event for a pubkey', () => {
    const pubkey = 'e'.repeat(64)
    const newest = relayListEvent(pubkey, 50)

    cacheProfileRelayList(newest)
    cacheProfileRelayList(relayListEvent(pubkey, 30))

    expect(getCachedProfileRelayList(pubkey)).toEqual(newest)
  })

  it('expires cached relay lists after one week', () => {
    const pubkey = 'f'.repeat(64)
    const event = relayListEvent(pubkey, 60)
    const nowSpy = vi.spyOn(Date, 'now')

    try {
      nowSpy.mockReturnValue(1_000)
      cacheProfileRelayList(event)
      nowSpy.mockReturnValue(1_000 + 7 * 24 * 60 * 60 * 1000 + 1)

      expect(getCachedProfileRelayList(pubkey)).toBeNull()
      expect(getCachedProfileRelayLists([pubkey])).toEqual([])
    } finally {
      nowSpy.mockRestore()
    }
  })
})
