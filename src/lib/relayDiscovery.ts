import { tagValue, type NestrEvent } from './nostr'

export const SAVED_RELAYS_STORAGE_KEY = 'nestr/relays'

export function normalizeRelayUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const withScheme = trimmed.includes('://') ? trimmed : `wss://${trimmed}`
    const url = new URL(withScheme)
    if (url.protocol === 'https:') url.protocol = 'wss:'
    if (url.protocol === 'http:') url.protocol = 'ws:'
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return trimmed.replace(/\/$/, '')
  }
}

export function uniqueRelayUrls(relays: readonly string[]) {
  return Array.from(new Set(relays.map(normalizeRelayUrl).filter(Boolean)))
}

export function sameRelayUrl(a: string, b: string) {
  return normalizeRelayUrl(a) === normalizeRelayUrl(b)
}

export function relayGroupKey(relayUrl: string, groupId: string) {
  return `${normalizeRelayUrl(relayUrl)}#${groupId}`
}

export function relayUrlFromGroupEvent(event: Pick<NestrEvent, 'tags'>, fallbackRelayUrl: string) {
  return normalizeRelayUrl(tagValue(event, 'relay') ?? fallbackRelayUrl)
}

export function withRelayTag(event: NestrEvent, relayUrl: string): NestrEvent {
  const normalized = normalizeRelayUrl(relayUrl)
  const existing = tagValue(event, 'relay')
  if (existing && sameRelayUrl(existing, normalized)) return event
  return {
    ...event,
    tags: [...event.tags.filter((tag) => tag[0] !== 'relay'), ['relay', normalized]],
  }
}

function browserStorage() {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

export function readSavedRelayUrls(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()) {
  if (!storage) return []
  try {
    const raw = storage.getItem(SAVED_RELAYS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? uniqueRelayUrls(parsed.filter((value): value is string => typeof value === 'string')) : []
  } catch {
    return []
  }
}

export function writeSavedRelayUrls(relays: readonly string[], storage: Pick<Storage, 'setItem'> | undefined = browserStorage()) {
  if (!storage) return
  storage.setItem(SAVED_RELAYS_STORAGE_KEY, JSON.stringify(uniqueRelayUrls(relays)))
}
