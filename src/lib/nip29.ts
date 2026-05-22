import { NIP29_KINDS, dTag, groupTag, hasTag, tagValue, type NestrEvent, type NostrTag } from './nostr'

export interface Nip29MetadataDraft {
  name: string
  about: string
  picture: string
  private: boolean
  restricted: boolean
  closed: boolean
  hidden: boolean
}

export type Nip29Result = { ok: boolean; event?: NestrEvent; reason?: string }

export function isNip29ModerationKind(kind: number) {
  return kind >= 9000 && kind <= 9020
}

export function groupMetadataDraft(event: Pick<NestrEvent, 'tags'>): Nip29MetadataDraft {
  return {
    name: tagValue(event, 'name') ?? '',
    about: tagValue(event, 'about') ?? '',
    picture: tagValue(event, 'picture') ?? '',
    private: hasTag(event, 'private'),
    restricted: hasTag(event, 'restricted'),
    closed: hasTag(event, 'closed'),
    hidden: hasTag(event, 'hidden'),
  }
}

export function metadataTags(groupId: string, draft: Nip29MetadataDraft, tagName: 'h' | 'd' = 'h') {
  const tags: NostrTag[] = [tagName === 'h' ? groupTag(groupId) : dTag(groupId)]
  const name = draft.name.trim()
  const about = draft.about.trim()
  const picture = draft.picture.trim()

  if (name) tags.push(['name', name])
  if (about) tags.push(['about', about])
  if (picture) tags.push(['picture', picture])
  if (draft.private) tags.push(['private'])
  if (draft.restricted) tags.push(['restricted'])
  if (draft.closed) tags.push(['closed'])
  if (draft.hidden) tags.push(['hidden'])

  return tags
}

export function memberPubkeys(event: Pick<NestrEvent, 'tags'>) {
  return event.tags.filter((tag) => tag[0] === 'p' && tag[1]).map((tag) => tag[1])
}

export function adminRoleMap(event: Pick<NestrEvent, 'tags'>) {
  const roles = new Map<string, string[]>()
  event.tags
    .filter((tag) => tag[0] === 'p' && tag[1])
    .forEach((tag) => roles.set(tag[1], tag.slice(2).filter(Boolean)))
  return roles
}

export function supportedRoleTags(event: Pick<NestrEvent, 'tags'>) {
  return event.tags
    .filter((tag) => tag[0] === 'role' && tag[1])
    .map((tag) => ({ name: tag[1], description: tag[2] ?? '' }))
}

export function targetPubkey(event: Pick<NestrEvent, 'tags'>) {
  return event.tags.find((tag) => tag[0] === 'p' && tag[1])?.[1]
}

export function targetRoles(event: Pick<NestrEvent, 'tags'>) {
  return event.tags.find((tag) => tag[0] === 'p' && tag[1])?.slice(2).filter(Boolean) ?? []
}

export function targetEventId(event: Pick<NestrEvent, 'tags'>) {
  return event.tags.find((tag) => tag[0] === 'e' && tag[1])?.[1]
}

export function pendingJoinRequests(events: NestrEvent[], members: Set<string>) {
  const latestByPubkey = new Map<string, NestrEvent>()

  events
    .filter((event) => event.kind === NIP29_KINDS.joinRequest)
    .forEach((event) => {
      const previous = latestByPubkey.get(event.pubkey)
      if (!previous || previous.created_at <= event.created_at) latestByPubkey.set(event.pubkey, event)
    })

  return Array.from(latestByPubkey.values())
    .filter((event) => !members.has(event.pubkey))
    .sort((a, b) => b.created_at - a.created_at)
}

export function moderationSummary(event: NestrEvent) {
  if (event.kind === NIP29_KINDS.putUser) return `put-user ${targetPubkey(event) ?? ''}`.trim()
  if (event.kind === NIP29_KINDS.removeUser) return `remove-user ${targetPubkey(event) ?? ''}`.trim()
  if (event.kind === NIP29_KINDS.editMetadata) return 'edit-metadata'
  if (event.kind === NIP29_KINDS.deleteEvent) return `delete-event ${targetEventId(event) ?? ''}`.trim()
  if (event.kind === NIP29_KINDS.createGroup) return 'create-group'
  if (event.kind === NIP29_KINDS.deleteGroup) return 'delete-group'
  if (event.kind === NIP29_KINDS.createInvite) return `create-invite ${tagValue(event, 'code') ?? ''}`.trim()
  if (event.kind === NIP29_KINDS.leaveRequest) return `leave-request ${event.pubkey}`
  if (event.kind === NIP29_KINDS.joinRequest) return `join-request ${event.pubkey}`
  return `kind:${event.kind}`
}
