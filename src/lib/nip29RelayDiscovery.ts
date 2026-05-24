import { SimplePool } from 'nostr-tools'
import { NIP29_KINDS, tagValue, type NestrEvent } from './nostr'
import { normalizeRelayUrl } from './relayDiscovery'

export const NIP66_RELAY_DISCOVERY_KIND = 30166

export const NIP29_DISCOVERY_BOOTSTRAP_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
] as const

const DISCOVERY_LOOKBACK_SECONDS = 14 * 24 * 60 * 60
const MAX_DISCOVERED_RELAYS = 36

export interface DiscoveredNip29Relay {
  url: string
  name: string
  description: string
  icon: string
  updatedAt: number
  monitorCount: number
  rttOpen: number | null
  rttRead: number | null
  requiresAuth: boolean | null
  requiresPayment: boolean | null
  sourceRelays: string[]
}

function numericTag(event: NestrEvent, name: string) {
  const value = tagValue(event, name)
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function nip11Content(event: NestrEvent) {
  if (!event.content.trim()) return null
  try {
    const parsed = JSON.parse(event.content) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function tagValues(event: NestrEvent, names: string[]) {
  return event.tags
    .filter((tag) => names.includes(tag[0]) && tag[1])
    .flatMap((tag) => tag.slice(1).filter(Boolean))
}

function eventAdvertisesNip29(event: NestrEvent) {
  const nipTags = tagValues(event, ['N', 'nips']).map((value) => value.toLowerCase())
  if (nipTags.includes('29') || nipTags.includes('nip29') || nipTags.includes('nip-29')) return true

  const acceptedKinds = tagValues(event, ['k']).map((value) => value.replace(/^!/, ''))
  if (acceptedKinds.includes(String(NIP29_KINDS.groupMetadata))) return true

  const content = nip11Content(event)
  const supported = content?.supported_nips
  return Array.isArray(supported) && supported.some((nip) => String(nip) === '29')
}

function boolRequirement(event: NestrEvent, name: string) {
  const tags = tagValues(event, ['R']).map((value) => value.toLowerCase())
  if (tags.includes(name)) return true
  if (tags.includes(`!${name}`)) return false

  const content = nip11Content(event)
  const limitations = content?.limitation
  if (!limitations || typeof limitations !== 'object') return null
  const value = (limitations as Record<string, unknown>)[`${name}_required`]
  return typeof value === 'boolean' ? value : null
}

function canonicalRelayServerUrl(value: string) {
  const normalized = normalizeRelayUrl(value)
  const url = new URL(normalized)
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function discoveredNip29RelayFromEvent(event: NestrEvent): DiscoveredNip29Relay | null {
  if (event.kind !== NIP66_RELAY_DISCOVERY_KIND || !eventAdvertisesNip29(event)) return null
  const relayUrl = tagValue(event, 'd')
  if (!relayUrl || !/^wss?:\/\//i.test(relayUrl)) return null

  const content = nip11Content(event)
  let url: string
  let host: string
  try {
    url = canonicalRelayServerUrl(relayUrl)
    host = new URL(url).host
  } catch {
    return null
  }
  const name = typeof content?.name === 'string' && content.name.trim() ? content.name.trim() : host
  const description =
    typeof content?.description === 'string' && content.description.trim()
      ? content.description.trim()
      : 'Advertised by NIP-66 as supporting NIP-29 groups.'
  const icon = typeof content?.icon === 'string' ? content.icon : ''

  return {
    url,
    name,
    description,
    icon,
    updatedAt: event.created_at,
    monitorCount: 1,
    rttOpen: numericTag(event, 'rtt-open'),
    rttRead: numericTag(event, 'rtt-read'),
    requiresAuth: boolRequirement(event, 'auth'),
    requiresPayment: boolRequirement(event, 'payment'),
    sourceRelays: [],
  }
}

export function mergeDiscoveredNip29Relays(events: NestrEvent[], sourceRelay = '') {
  const relays = new Map<string, DiscoveredNip29Relay>()

  events.forEach((event) => {
    const discovered = discoveredNip29RelayFromEvent(event)
    if (!discovered) return

    const existing = relays.get(discovered.url)
    if (!existing) {
      relays.set(discovered.url, {
        ...discovered,
        sourceRelays: sourceRelay ? [sourceRelay] : [],
      })
      return
    }

    existing.monitorCount += 1
    if (sourceRelay && !existing.sourceRelays.includes(sourceRelay)) existing.sourceRelays.push(sourceRelay)
    if (discovered.updatedAt >= existing.updatedAt) {
      existing.name = discovered.name
      existing.description = discovered.description
      existing.icon = discovered.icon
      existing.updatedAt = discovered.updatedAt
      existing.rttOpen = discovered.rttOpen
      existing.rttRead = discovered.rttRead
      existing.requiresAuth = discovered.requiresAuth
      existing.requiresPayment = discovered.requiresPayment
    }
  })

  return sortDiscoveredNip29Relays(Array.from(relays.values()))
}

export function sortDiscoveredNip29Relays(relays: DiscoveredNip29Relay[]) {
  return relays
    .slice()
    .sort((a, b) => {
      const aRtt = a.rttRead ?? a.rttOpen ?? Number.POSITIVE_INFINITY
      const bRtt = b.rttRead ?? b.rttOpen ?? Number.POSITIVE_INFINITY
      if (a.requiresPayment !== b.requiresPayment) return a.requiresPayment ? 1 : -1
      if (aRtt !== bRtt) return aRtt - bRtt
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
      return a.url.localeCompare(b.url)
    })
    .slice(0, MAX_DISCOVERED_RELAYS)
}

export function subscribeNip29RelayDiscovery(
  onRelays: (relays: DiscoveredNip29Relay[]) => void,
  onStatus?: (status: string) => void,
  discoveryRelays = NIP29_DISCOVERY_BOOTSTRAP_RELAYS,
) {
  const pool = new SimplePool({ enableReconnect: true })
  const discovered = new Map<string, DiscoveredNip29Relay>()
  const sourceRelays = discoveryRelays.map(normalizeRelayUrl)
  const since = Math.floor(Date.now() / 1000) - DISCOVERY_LOOKBACK_SECONDS

  const publish = () => onRelays(sortDiscoveredNip29Relays(Array.from(discovered.values())))
  const applyEvent = (event: NestrEvent, sourceRelay: string) => {
    const relay = discoveredNip29RelayFromEvent(event)
    if (!relay) return
    const existing = discovered.get(relay.url)
    if (!existing) {
      discovered.set(relay.url, { ...relay, sourceRelays: [sourceRelay] })
      publish()
      return
    }

    existing.monitorCount += 1
    if (!existing.sourceRelays.includes(sourceRelay)) existing.sourceRelays.push(sourceRelay)
    if (relay.updatedAt >= existing.updatedAt) {
      discovered.set(relay.url, {
        ...relay,
        monitorCount: existing.monitorCount,
        sourceRelays: existing.sourceRelays,
      })
      publish()
    }
  }

  onStatus?.(`listening on ${sourceRelays.length} discovery relays`)
  const subscriptions = sourceRelays.map((relayUrl) =>
    pool.subscribe(
      [relayUrl],
      { kinds: [NIP66_RELAY_DISCOVERY_KIND], '#N': ['29'], since, limit: 120 },
      {
        onevent: (event) => applyEvent(event as NestrEvent, relayUrl),
        oneose: () => onStatus?.(`found ${discovered.size} advertised NIP-29 relays`),
        eoseTimeout: 5000,
      },
    ),
  )

  return () => {
    subscriptions.forEach((subscription) => subscription.close())
    pool.close(sourceRelays)
  }
}
