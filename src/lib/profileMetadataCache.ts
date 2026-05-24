import type { NestrEvent } from './nostr'

const PROFILE_METADATA_CACHE_KEY = 'nestr.profileMetadata.v1'
const PROFILE_METADATA_CACHE_LIMIT = 500

interface CachedProfileMetadata {
  storedAt: number
  event: NestrEvent
}

type ProfileMetadataCache = Record<string, CachedProfileMetadata>

interface ProfileCacheStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

const memoryStorage = new Map<string, string>()

function usableStorage(value: unknown): value is ProfileCacheStorage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProfileCacheStorage).getItem === 'function' &&
    typeof (value as ProfileCacheStorage).setItem === 'function' &&
    typeof (value as ProfileCacheStorage).removeItem === 'function'
  )
}

function storage(): ProfileCacheStorage {
  if (typeof window !== 'undefined' && usableStorage(window.localStorage)) return window.localStorage
  if (usableStorage(globalThis.localStorage)) return globalThis.localStorage

  return {
    getItem: (key) => memoryStorage.get(key) ?? null,
    setItem: (key, value) => {
      memoryStorage.set(key, value)
    },
    removeItem: (key) => {
      memoryStorage.delete(key)
    },
  }
}

function safeGetItem(key: string) {
  const cacheStorage = storage()
  try {
    return cacheStorage.getItem(key)
  } catch {
    return null
  }
}

function isProfileMetadataEvent(event: NestrEvent) {
  return event.kind === 0 && /^[0-9a-f]{64}$/i.test(event.pubkey)
}

function readProfileMetadataCache(): ProfileMetadataCache {
  try {
    const raw = safeGetItem(PROFILE_METADATA_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ProfileMetadataCache
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {}
  }
}

function writeProfileMetadataCache(cache: ProfileMetadataCache) {
  const entries = Object.entries(cache)
    .filter(([, cached]) => cached?.event && isProfileMetadataEvent(cached.event))
    .sort(([, a], [, b]) => b.storedAt - a.storedAt)
    .slice(0, PROFILE_METADATA_CACHE_LIMIT)

  try {
    storage().setItem(PROFILE_METADATA_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Profile metadata is opportunistic; storage failures should not affect relay behavior.
  }
}

export function getCachedProfileMetadata(pubkey: string) {
  const cached = readProfileMetadataCache()[pubkey.toLowerCase()]
  if (!cached?.event || !isProfileMetadataEvent(cached.event)) return null
  return cached.event
}

export function getCachedProfileMetadatas(pubkeys: string[]) {
  const cache = readProfileMetadataCache()
  return pubkeys
    .map((pubkey) => cache[pubkey.toLowerCase()]?.event)
    .filter((event): event is NestrEvent => Boolean(event && isProfileMetadataEvent(event)))
}

export function cacheProfileMetadata(event: NestrEvent) {
  if (!isProfileMetadataEvent(event)) return

  const pubkey = event.pubkey.toLowerCase()
  const cache = readProfileMetadataCache()
  const existing = cache[pubkey]?.event
  if (existing && existing.created_at > event.created_at) return

  cache[pubkey] = { storedAt: Date.now(), event: { ...event, pubkey } }
  writeProfileMetadataCache(cache)
}

export function clearProfileMetadataCache() {
  try {
    storage().removeItem(PROFILE_METADATA_CACHE_KEY)
    memoryStorage.delete(PROFILE_METADATA_CACHE_KEY)
  } catch {
    // Ignore cache cleanup failures.
  }
}
