import { beforeEach, describe, expect, it } from 'vitest'
import type { NestrEvent } from './nostr'
import {
  cacheProfileMetadata,
  clearProfileMetadataCache,
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
})
