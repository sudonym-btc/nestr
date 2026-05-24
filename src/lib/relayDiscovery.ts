import { tagValue, type NestrEvent } from './nostr'

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
