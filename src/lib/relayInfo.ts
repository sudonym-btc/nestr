import { normalizeRelayUrl } from './relayDiscovery'

export interface RelayInfo {
  name?: string
  description?: string
  icon?: string
  pubkey?: string
  fetchedAt: number
}

const CACHE_KEY = 'nestr/relay-info-v1'
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000

type RelayInfoCache = Record<string, RelayInfo>

function storage() {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

function readCache(store = storage()): RelayInfoCache {
  if (!store) return {}
  try {
    const raw = store.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) as RelayInfoCache : {}
  } catch {
    return {}
  }
}

function writeCache(cache: RelayInfoCache, store = storage()) {
  if (!store) return
  try {
    store.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // localStorage can be unavailable or full; relay icons are best-effort.
  }
}

export function relayInfoHttpUrl(relayUrl: string) {
  const normalized = normalizeRelayUrl(relayUrl)
  return normalized.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
}

export function faviconFor(relayUrl: string) {
  try {
    const url = new URL(relayInfoHttpUrl(relayUrl))
    return `${url.protocol}//${url.host}/favicon.ico`
  } catch {
    return null
  }
}

export function relayIconCandidates(relayUrl: string, info?: RelayInfo | null) {
  void relayUrl
  const urls: string[] = []
  if (info?.icon) urls.push(info.icon)

  return Array.from(new Set(urls))
}

function resolveRelayUrl(value: unknown, relayUrl: string) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return new URL(value, relayInfoHttpUrl(relayUrl)).toString()
  } catch {
    return undefined
  }
}

const inflight = new Map<string, Promise<RelayInfo | null>>()

export async function fetchRelayInfo(relayUrl: string): Promise<RelayInfo | null> {
  const normalized = normalizeRelayUrl(relayUrl)
  const cache = readCache()
  const cached = cache[normalized]
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached

  const existing = inflight.get(normalized)
  if (existing) return existing

  const request = (async () => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(relayInfoHttpUrl(normalized), {
        headers: { Accept: 'application/nostr+json' },
        signal: controller.signal,
      })
      if (!response.ok) return null

      const json = await response.json() as Record<string, unknown>
      const info: RelayInfo = {
        name: typeof json.name === 'string' ? json.name : undefined,
        description: typeof json.description === 'string' ? json.description : undefined,
        icon: resolveRelayUrl(json.icon, normalized),
        pubkey: typeof json.pubkey === 'string' && /^[0-9a-f]{64}$/i.test(json.pubkey)
          ? json.pubkey.toLowerCase()
          : undefined,
        fetchedAt: Date.now(),
      }
      const next = readCache()
      next[normalized] = info
      writeCache(next)
      return info
    } catch {
      return null
    } finally {
      window.clearTimeout(timeout)
      inflight.delete(normalized)
    }
  })()

  inflight.set(normalized, request)
  return request
}
