import { nip19 } from 'nostr-tools'

const NOSTR_ENTITY_PATTERN =
  /(nostr:)?((?:nprofile|nevent|naddr|npub|note)1[023456789acdefghjklmnpqrstuvwxyz]+)/gi
const LEGACY_REFERENCE_PATTERN = /#\[(\d+)]/g

export interface TextPart {
  type: 'text'
  text: string
}

export interface EntityPart {
  type: 'entity'
  raw: string
  code: string
  entityType: 'profile' | 'event' | 'address'
  pubkey?: string
  eventId?: string
  kind?: number
  identifier?: string
  href: string
}

export type NostrReferencePart = TextPart | EntityPart

interface EntityMatch {
  start: number
  end: number
  part: EntityPart
}

function safeDecode(code: string) {
  try {
    return nip19.decode(code)
  } catch {
    return null
  }
}

function hex(value: string | undefined) {
  return value && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined
}

function entityPart(raw: string, code: string): EntityPart | null {
  const decoded = safeDecode(code)
  if (!decoded || decoded.type === 'nsec') return null

  if (decoded.type === 'npub') {
    return {
      type: 'entity',
      raw,
      code,
      entityType: 'profile',
      pubkey: decoded.data,
      href: `https://njump.me/${code}`,
    }
  }

  if (decoded.type === 'nprofile') {
    return {
      type: 'entity',
      raw,
      code,
      entityType: 'profile',
      pubkey: decoded.data.pubkey,
      href: `https://njump.me/${code}`,
    }
  }

  if (decoded.type === 'note') {
    return {
      type: 'entity',
      raw,
      code,
      entityType: 'event',
      eventId: decoded.data,
      href: `https://njump.me/${code}`,
    }
  }

  if (decoded.type === 'nevent') {
    return {
      type: 'entity',
      raw,
      code,
      entityType: 'event',
      eventId: decoded.data.id,
      pubkey: decoded.data.author,
      kind: decoded.data.kind,
      href: `https://njump.me/${code}`,
    }
  }

  if (decoded.type === 'naddr') {
    return {
      type: 'entity',
      raw,
      code,
      entityType: 'address',
      pubkey: decoded.data.pubkey,
      kind: decoded.data.kind,
      identifier: decoded.data.identifier,
      href: `https://njump.me/${code}`,
    }
  }

  return null
}

function tagReference(raw: string, tag: string[] | undefined): EntityPart | null {
  if (!tag) return null

  if (tag[0] === 'p' && hex(tag[1])) {
    const relay = tag[2] ? [tag[2]] : undefined
    const code = nip19.nprofileEncode({ pubkey: tag[1].toLowerCase(), relays: relay })
    return entityPart(raw, code)
  }

  if ((tag[0] === 'e' || tag[0] === 'q') && hex(tag[1])) {
    const relay = tag[2] ? [tag[2]] : undefined
    const code = nip19.neventEncode({
      id: tag[1].toLowerCase(),
      relays: relay,
      author: hex(tag[3]),
    })
    return entityPart(raw, code)
  }

  if (tag[0] === 'a' && tag[1]) {
    const [kind, pubkey, ...identifierParts] = tag[1].split(':')
    const parsedKind = Number.parseInt(kind, 10)
    const parsedPubkey = hex(pubkey)
    if (!Number.isFinite(parsedKind) || !parsedPubkey) return null

    const code = nip19.naddrEncode({
      kind: parsedKind,
      pubkey: parsedPubkey,
      identifier: identifierParts.join(':'),
      relays: tag[2] ? [tag[2]] : undefined,
    })
    return entityPart(raw, code)
  }

  return null
}

export function parseNostrReferences(content: string, tags: string[][] = []): NostrReferencePart[] {
  const matches: EntityMatch[] = []

  for (const match of content.matchAll(NOSTR_ENTITY_PATTERN)) {
    const raw = match[0]
    const code = match[2].toLowerCase()
    const start = match.index ?? 0
    const part = entityPart(raw, code)
    if (part) matches.push({ start, end: start + raw.length, part })
  }

  for (const match of content.matchAll(LEGACY_REFERENCE_PATTERN)) {
    const raw = match[0]
    const start = match.index ?? 0
    const tag = tags[Number.parseInt(match[1], 10)]
    const part = tagReference(raw, tag)
    if (part) matches.push({ start, end: start + raw.length, part })
  }

  matches.sort((a, b) => a.start - b.start)

  const parts: NostrReferencePart[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    if (match.start > cursor) {
      parts.push({ type: 'text', text: content.slice(cursor, match.start) })
    }
    parts.push(match.part)
    cursor = match.end
  }

  if (cursor < content.length) {
    parts.push({ type: 'text', text: content.slice(cursor) })
  }

  return parts.length > 0 ? parts : [{ type: 'text', text: content }]
}

export function profilePubkeysFromReferences(content: string, tags: string[][] = []) {
  return Array.from(
    new Set(
      parseNostrReferences(content, tags)
        .filter((part): part is EntityPart => part.type === 'entity' && part.entityType === 'profile')
        .map((part) => part.pubkey)
        .filter((pubkey): pubkey is string => Boolean(pubkey)),
    ),
  )
}
