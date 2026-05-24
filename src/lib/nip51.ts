import { NIP51_KINDS, type NestrEvent } from './nostr'
import { normalizeRelayUrl, uniqueRelayUrls } from './relayDiscovery'

export interface SimpleGroupPointer {
  groupId: string
  relayUrl: string
  name?: string
}

export interface SimpleGroupsList {
  event: NestrEvent
  groups: SimpleGroupPointer[]
  relays: string[]
  explicitRelayUrls: string[]
}

export function parseSimpleGroupsEvent(event: NestrEvent): SimpleGroupsList | null {
  if (event.kind !== NIP51_KINDS.simpleGroups) return null

  const groups: SimpleGroupPointer[] = []
  const relays: string[] = []
  const explicitRelayUrls: string[] = []
  const seenGroups = new Set<string>()

  event.tags.forEach((tag) => {
    if (tag[0] === 'group') {
      const groupId = tag[1]?.trim()
      const relayUrl = normalizeRelayUrl(tag[2] ?? '')
      if (!groupId || !relayUrl) return

      const key = `${relayUrl}#${groupId}`
      if (seenGroups.has(key)) return
      seenGroups.add(key)
      groups.push({
        groupId,
        relayUrl,
        name: tag[3]?.trim() || undefined,
      })
      relays.push(relayUrl)
      return
    }

    if (tag[0] === 'r') {
      const relayUrl = normalizeRelayUrl(tag[1] ?? '')
      if (relayUrl) {
        relays.push(relayUrl)
        explicitRelayUrls.push(relayUrl)
      }
    }
  })

  return {
    event,
    groups,
    relays: uniqueRelayUrls(relays),
    explicitRelayUrls: uniqueRelayUrls(explicitRelayUrls),
  }
}
