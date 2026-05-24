import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import {
  DEFAULT_GROUP_ID,
  MOCK_RELAY_URL,
  NIP29_KINDS,
  OFFICE_KINDS,
  dTag,
  groupTag,
  isEphemeralKind,
  tagValue,
  type NestrDirectMessage,
  type NestrEvent,
  type NestrAttachment,
} from './nostr'
import { attachmentLabel, attachmentTags, contentWithAttachmentUrls } from './attachments'
import { npubForPubkey, resolvePubkey, seededSecret, shortNpub } from './avatar'
import {
  groupMetadataDraft,
  isNip29ModerationKind,
  memberPubkeys,
  metadataTags,
  pendingJoinRequests,
  targetEventId,
  targetPubkey,
  targetRoles,
  type Nip29MetadataDraft,
  type Nip29Result,
} from './nip29'
import {
  buildOfficeMap,
  spawnForPubkey,
  type OfficeMap,
  type WorldPosition,
} from './world'
import {
  createPositionPayload,
  parsePositionPayload,
  resolveWorldPosition,
  worldPositionFromPayload,
  type PositionMovement,
} from './positionEvents'

const encoder = new TextEncoder()

function isOfficePositionKind(kind: number) {
  return kind === OFFICE_KINDS.avatarPosition
}

function replaceableEventKey(event: NestrEvent) {
  if (event.kind < 30000 || event.kind >= 40000) return ''
  const d = tagValue(event, 'd')
  return d ? `${event.kind}:${event.pubkey}:${d}` : ''
}

export interface MockUser {
  pubkey: string
  npub: string
  name: string
  role: string
  pictureUrl?: string
  pictureCandidates?: string[]
  blossomServers?: string[]
  dmRelays?: string[]
  readRelays?: string[]
  writeRelays?: string[]
  secretKey?: Uint8Array
}

export interface MockRelayOptions {
  relayUrl?: string
  groupId?: string
  persist?: boolean
  authRequired?: boolean
}

export interface Nip29Group {
  id: string
  relay: string
  metadata: NestrEvent
  admins: NestrEvent
  members: NestrEvent
  roles: NestrEvent
}

export interface RelaySnapshot {
  mode?: 'mock' | 'live'
  connectionStatus?: 'mock' | 'connecting' | 'connected' | 'authenticated' | 'disconnected' | 'error'
  connectionMessage?: string
  connectionLog?: string[]
  roomAccessStatus?: 'unknown' | 'open' | 'auth-required' | 'blocked' | 'closed'
  roomAccessMessage?: string
  relayError?: {
    id: string
    kind?: number
    eventId?: string
    message: string
    createdAt: number
  }
  relayUrls?: string[]
  savedRelayUrls?: string[]
  savedGroupsLoading?: boolean
  dmSubscriptionsLoading?: boolean
  dmSubscriptionStatus?: {
    legacyEose: boolean
    nip17Eose: boolean
  }
  savedGroupKeys?: string[]
  group: Nip29Group
  relayGroups: NestrEvent[]
  users: MockUser[]
  messages: NestrEvent[]
  directMessages: NestrDirectMessage[]
  joinRequests: NestrEvent[]
  moderationEvents: NestrEvent[]
  invites: NestrEvent[]
  deletedEventIds: string[]
  positions: WorldPosition[]
  presence: Record<string, number>
  eventCount: number
}

type RelayListener = (snapshot: RelaySnapshot, event?: NestrEvent) => void

interface StoredMockRelayState {
  events: NestrEvent[]
  relayGroups: NestrEvent[]
  deletedEventIds: string[]
}

function sign(template: Omit<NestrEvent, 'id' | 'sig'>, secretKey: Uint8Array): NestrEvent {
  return finalizeEvent(template, secretKey) as NestrEvent
}

function mockSignature(template: Omit<NestrEvent, 'id' | 'sig'>) {
  const id = bytesToHex(sha256(encoder.encode(JSON.stringify([0, template]))))
  return {
    ...template,
    id,
    sig: `mock-${id.slice(0, 24)}`,
  }
}

function now() {
  return Math.floor(Date.now() / 1000)
}

function makeDemoUser(seed: string, name: string, role: string): MockUser {
  const secretKey = seededSecret(seed)
  const pubkey = getPublicKey(secretKey)

  return {
    pubkey,
    npub: npubForPubkey(pubkey),
    name,
    role,
    blossomServers: ['https://blossom.primal.net', 'https://cdn.satellite.earth'],
    dmRelays: [MOCK_RELAY_URL],
    readRelays: [MOCK_RELAY_URL],
    writeRelays: [MOCK_RELAY_URL],
    secretKey,
  }
}

const demoUsers = [
  makeDemoUser('som', 'Som', 'admin'),
  makeDemoUser('brad', 'Brad', 'moderator'),
  makeDemoUser('ava', 'Ava', 'designer'),
  makeDemoUser('mei', 'Mei', 'engineer'),
  makeDemoUser('lina', 'Lina', 'support'),
  makeDemoUser('rio', 'Rio', 'ops'),
  makeDemoUser('noor', 'Noor', 'research'),
  makeDemoUser('kit', 'Kit', 'guest'),
]

export class MockNip29Relay {
  readonly mode = 'mock' as const
  readonly relayUrl: string
  readonly relayPubkey: string

  private readonly relaySecret = seededSecret('relay')
  private readonly persistState: boolean
  private readonly authRequired: boolean
  private readonly storageKey: string
  private groupId = DEFAULT_GROUP_ID
  private readonly listeners = new Set<RelayListener>()
  private readonly events: NestrEvent[] = []
  private readonly seededEventIds = new Set<string>()
  private readonly directMessages: NestrDirectMessage[] = []
  private readonly relayGroupEvents = new Map<string, NestrEvent>()
  private readonly users = new Map<string, MockUser>()
  private readonly positions = new Map<string, WorldPosition>()
  private readonly activityAt = new Map<string, number>()
  private readonly memberPubkeys = new Set<string>()
  private readonly adminRoles = new Map<string, string[]>()
  private readonly deletedEventIds = new Set<string>()
  private lastSignedPositionEvent?: NestrEvent
  private group: Nip29Group

  constructor(options: MockRelayOptions = {}) {
    this.relayUrl = options.relayUrl ?? MOCK_RELAY_URL
    this.groupId = options.groupId ?? DEFAULT_GROUP_ID
    this.persistState = options.persist ?? false
    this.authRequired = options.authRequired ?? false
    this.storageKey = `nestr:mock-relay:${this.relayUrl}`
    this.relayPubkey = getPublicKey(this.relaySecret)
    demoUsers.forEach((user) => this.memberPubkeys.add(user.pubkey))
    this.adminRoles.set(demoUsers[0].pubkey, ['admin'])
    this.adminRoles.set(demoUsers[1].pubkey, ['moderator'])
    this.group = this.createGroup()
    this.relayGroupEvents.set(this.groupId, this.group.metadata)
    demoUsers.forEach((user, index) => this.addSeedUser(user, index))
    this.seedMessages()
    this.seedDirectMessages()
    this.restorePersistedState()
    this.group = this.createGroup(this.groupId)
  }

  private storage() {
    if (!this.persistState || typeof globalThis.localStorage === 'undefined') return null
    try {
      return globalThis.localStorage
    } catch {
      return null
    }
  }

  private restorePersistedState() {
    const storage = this.storage()
    if (!storage) return

    try {
      const raw = storage.getItem(this.storageKey)
      if (!raw) return
      const state = JSON.parse(raw) as Partial<StoredMockRelayState>

      state.relayGroups?.forEach((event) => {
        const groupId = tagValue(event, 'd') ?? tagValue(event, 'h')
        if (groupId) this.relayGroupEvents.set(groupId, event)
      })

      const existingIds = new Set(this.events.map((event) => event.id))
      state.events?.forEach((event) => {
        if (!event?.id || existingIds.has(event.id)) return
        this.ensureKnownUser(event.pubkey)
        if (isNip29ModerationKind(event.kind)) this.applyModerationEvent(event)
        this.events.push(event)
        existingIds.add(event.id)
      })

      state.deletedEventIds?.forEach((eventId) => this.deletedEventIds.add(eventId))
    } catch {
      storage.removeItem(this.storageKey)
    }
  }

  private persist() {
    const storage = this.storage()
    if (!storage) return

    const state: StoredMockRelayState = {
      events: this.events.filter((event) => !this.seededEventIds.has(event.id)),
      relayGroups: Array.from(this.relayGroupEvents.values()),
      deletedEventIds: Array.from(this.deletedEventIds),
    }
    storage.setItem(this.storageKey, JSON.stringify(state))
  }

  snapshot(): RelaySnapshot {
    const messages = this.events
      .filter((event) => event.kind === NIP29_KINDS.chatMessage)
      .filter((event) => tagValue(event, 'h') === this.groupId)
      .filter((event) => !this.deletedEventIds.has(event.id))
      .sort((a, b) => a.created_at - b.created_at)
    const moderationEvents = this.events
      .filter((event) => isNip29ModerationKind(event.kind))
      .sort((a, b) => b.created_at - a.created_at)
    const members = new Set(memberPubkeys(this.group.members))

    return {
      mode: this.mode,
      connectionStatus: 'mock',
      connectionMessage: this.authRequired ? 'local development relay' : 'local open development relay',
      connectionLog: [this.authRequired ? 'local development relay' : 'local open development relay'],
      roomAccessStatus: 'open',
      roomAccessMessage: 'local room open',
      savedGroupsLoading: false,
      dmSubscriptionsLoading: false,
      dmSubscriptionStatus: { legacyEose: true, nip17Eose: true },
      savedGroupKeys: [],
      group: this.group,
      relayGroups: Array.from(this.relayGroupEvents.values()),
      users: Array.from(this.users.values()),
      messages,
      directMessages: this.directMessages.slice().sort((a, b) => a.createdAt - b.createdAt),
      joinRequests: pendingJoinRequests(this.events, members),
      moderationEvents,
      invites: this.events.filter((event) => event.kind === NIP29_KINDS.createInvite),
      deletedEventIds: Array.from(this.deletedEventIds),
      positions: Array.from(this.positions.values()).map((position) => resolveWorldPosition(position)),
      presence: Object.fromEntries(this.activityAt),
      eventCount: this.events.length,
    }
  }

  subscribe(listener: RelayListener) {
    this.listeners.add(listener)
    listener(this.snapshot())

    return () => {
      this.listeners.delete(listener)
    }
  }

  selectGroup(groupId: string) {
    if (!this.relayGroupEvents.has(groupId)) return false
    this.groupId = groupId
    this.group = this.createGroup(groupId)
    this.emit()
    return true
  }

  joinWithNpub(value: string) {
    const pubkey = resolvePubkey(value)
    const existing = this.users.get(pubkey)
    if (existing) return existing

    const user: MockUser = {
      pubkey,
      npub: npubForPubkey(pubkey),
      name: shortNpub(pubkey),
      role: 'guest',
      blossomServers: ['https://blossom.primal.net', 'https://cdn.satellite.earth'],
      dmRelays: [this.relayUrl],
      readRelays: [this.relayUrl],
      writeRelays: [this.relayUrl],
    }

    this.users.set(pubkey, user)
    this.memberPubkeys.add(pubkey)
    this.refreshGroupStateEvents()
    const map = buildOfficeMap(this.groupId, this.users.size)
    const spawn = spawnForPubkey(map, pubkey, this.users.size)
    this.publishPosition(pubkey, {
      startX: spawn.x,
      startY: spawn.y,
      endX: spawn.x,
      endY: spawn.y,
      speed: 0,
    })
    this.emit()
    return user
  }

  publishGroupMessage(pubkey: string, content: string, attachments: NestrAttachment[] = []) {
    const user = this.users.get(pubkey)
    const trimmed = content.trim()
    if (!user || (trimmed.length === 0 && attachments.length === 0)) {
      return { ok: false, reason: 'invalid-message' }
    }

    const template = {
      kind: NIP29_KINDS.chatMessage,
      pubkey,
      created_at: now(),
      tags: [groupTag(this.groupId), ...attachmentTags(attachments), ['client', 'nestr']],
      content: contentWithAttachmentUrls(trimmed, attachments),
    }

    const event = user.secretKey
      ? sign(template, user.secretKey)
      : mockSignature(template)

    return this.publish(event)
  }

  publishDirectMessage(
    senderPubkey: string,
    recipientPubkey: string,
    content: string,
    attachments: NestrAttachment[] = [],
  ) {
    this.ensureKnownUser(senderPubkey)
    this.ensureKnownUser(recipientPubkey)
    const trimmed = content.trim()
    if (!trimmed && attachments.length === 0) return { ok: false, reason: 'invalid-message' }

    const createdAt = now()
    const attachmentDigest = attachmentLabel(attachments)
    const id = bytesToHex(
      sha256(encoder.encode(`dm:${senderPubkey}:${recipientPubkey}:${trimmed}:${attachmentDigest}:${createdAt}`)),
    )
    this.directMessages.push({
      id,
      counterparty: recipientPubkey,
      senderPubkey,
      recipientPubkey,
      content: trimmed || attachmentDigest,
      attachments,
      createdAt,
      protocol: 'mock',
    })
    this.recordActivity(senderPubkey, createdAt * 1000)
    this.emit()

    if (recipientPubkey !== senderPubkey) {
      setTimeout(() => {
        const replyAt = now()
        this.directMessages.push({
          id: bytesToHex(sha256(encoder.encode(`dm-reply:${id}`))),
          counterparty: senderPubkey,
          senderPubkey: recipientPubkey,
          recipientPubkey: senderPubkey,
          content: `Got it: ${(trimmed || attachmentDigest).slice(0, 90)}`,
          createdAt: replyAt,
          protocol: 'mock',
        })
        this.recordActivity(recipientPubkey, replyAt * 1000)
        this.emit()
      }, 900)
    }

    return { ok: true, event: this.directMessages.at(-1) }
  }

  publishPosition(
    pubkey: string,
    movement: PositionMovement,
    sentAt = Date.now(),
  ) {
    const user = this.users.get(pubkey)
    if (!user) return { ok: false, reason: 'unknown-user' }

    const payload = createPositionPayload(movement, sentAt)
    const template = {
      kind: OFFICE_KINDS.avatarPosition,
      pubkey,
      created_at: now(),
      tags: [
        groupTag(this.groupId),
        ['relay', this.relayUrl],
        ['client', 'nestr'],
      ],
      content: payload,
    }

    const event = user.secretKey
      ? sign(template, user.secretKey)
      : mockSignature(template)

    this.lastSignedPositionEvent = event
    return this.publish(event)
  }

  republishLastPosition(pubkey: string) {
    const event = this.lastSignedPositionEvent
    if (!event || event.pubkey !== pubkey || !isOfficePositionKind(event.kind)) {
      return { ok: false, reason: 'position-refresh-missing' }
    }
    return this.publish(event)
  }

  publishJoinRequest(pubkey: string, content = '', code = ''): Nip29Result {
    this.ensureKnownUser(pubkey)
    if (this.memberPubkeys.has(pubkey)) return { ok: false, reason: 'duplicate: already a member' }

    const event = this.signUserEvent(pubkey, NIP29_KINDS.joinRequest, [
      groupTag(this.groupId),
      ...(code.trim() ? [['code', code.trim()]] : []),
      ['client', 'nestr'],
    ], content.trim())
    const result = this.publish(event)
    if (!result.ok) return result

    if (code.trim() && this.hasInviteCode(code.trim())) {
      this.publishRelayModeration(NIP29_KINDS.putUser, [['p', pubkey]], 'invite code accepted')
    }

    return result
  }

  publishLeaveRequest(pubkey: string, content = ''): Nip29Result {
    if (!this.users.has(pubkey)) return { ok: false, reason: 'unknown-user' }
    const event = this.signUserEvent(pubkey, NIP29_KINDS.leaveRequest, [
      groupTag(this.groupId),
      ['client', 'nestr'],
    ], content.trim())
    const result = this.publish(event)
    if (!result.ok) return result

    this.publishRelayModeration(NIP29_KINDS.removeUser, [['p', pubkey]], 'leave request accepted')
    return result
  }

  publishPutUser(pubkey: string, target: string, roles: string[] = [], content = '') {
    return this.publishAdminEvent(pubkey, NIP29_KINDS.putUser, [['p', target, ...roles]], content)
  }

  publishRemoveUser(pubkey: string, target: string, content = '') {
    return this.publishAdminEvent(pubkey, NIP29_KINDS.removeUser, [['p', target]], content)
  }

  publishEditMetadata(pubkey: string, draft: Nip29MetadataDraft, content = '', targetGroupId = this.groupId) {
    const groupId = targetGroupId.trim()
    if (!groupId) return { ok: false, reason: 'group-required' }
    return this.publishAdminEvent(
      pubkey,
      NIP29_KINDS.editMetadata,
      metadataTags(groupId, draft).slice(1),
      content,
      groupId,
    )
  }

  publishDeleteEvent(pubkey: string, eventId: string, content = '') {
    return this.publishAdminEvent(pubkey, NIP29_KINDS.deleteEvent, [['e', eventId]], content)
  }

  publishCreateGroup(pubkey: string, content = '', targetGroupId = this.groupId) {
    const groupId = targetGroupId.trim()
    if (!groupId) return { ok: false, reason: 'chatroom-id-required' }
    if (!this.canModerate(pubkey, NIP29_KINDS.createGroup)) {
      return { ok: false, reason: 'restricted: signer cannot create chatrooms' }
    }

    const event = this.signUserEvent(pubkey, NIP29_KINDS.createGroup, [
      groupTag(groupId),
      ['name', content.trim() || groupId],
      ['client', 'nestr'],
    ], content.trim())

    if (groupId === this.groupId) return this.publish(event)

    this.events.push(event)
    this.relayGroupEvents.set(groupId, this.createGroupMetadata(groupId, content.trim()))
    this.persist()
    this.emit(event)
    return { ok: true, event }
  }

  publishDeleteGroup(pubkey: string, content = '') {
    return this.publishAdminEvent(pubkey, NIP29_KINDS.deleteGroup, [], content)
  }

  publishCreateInvite(pubkey: string, code: string, content = '') {
    const trimmed = code.trim()
    if (!trimmed) return { ok: false, reason: 'invite-code-required' }
    return this.publishAdminEvent(pubkey, NIP29_KINDS.createInvite, [['code', trimmed]], content)
  }

  publish(event: NestrEvent) {
    if (tagValue(event, 'h') !== this.groupId && event.kind !== NIP29_KINDS.groupMetadata) {
      return { ok: false, reason: 'missing-nip29-h-tag' }
    }

    if (event.kind === NIP29_KINDS.joinRequest && this.memberPubkeys.has(event.pubkey)) {
      return { ok: false, reason: 'duplicate: already a member' }
    }

    if (isNip29ModerationKind(event.kind) && !this.canModerate(event.pubkey, event.kind)) {
      return { ok: false, reason: 'restricted: signer cannot perform this chatroom action' }
    }

    if (isOfficePositionKind(event.kind)) {
      const payload = parsePositionPayload(event.content)
      this.positions.set(event.pubkey, worldPositionFromPayload(event.pubkey, event, payload))
    }

    this.recordActivity(event.pubkey, isOfficePositionKind(event.kind) ? Date.now() : event.created_at * 1000)

    if (isNip29ModerationKind(event.kind)) {
      this.applyModerationEvent(event)
    }

    if (!isEphemeralKind(event.kind)) {
      const replaceableKey = replaceableEventKey(event)
      if (replaceableKey) {
        const index = this.events.findIndex((existing) => replaceableEventKey(existing) === replaceableKey)
        if (index >= 0) this.events.splice(index, 1, event)
        else this.events.push(event)
      } else {
        this.events.push(event)
      }
      this.persist()
    }

    this.emit(event)
    return { ok: true, event }
  }

  tickBots(excludePubkey: string, map: OfficeMap, frozenPubkeys: string[] = []) {
    const timestamp = Date.now()
    const frozen = new Set(frozenPubkeys)

    Array.from(this.users.values())
      .filter((user) => user.pubkey !== excludePubkey && !frozen.has(user.pubkey))
      .forEach((user, index) => {
        const current = resolveWorldPosition(this.positions.get(user.pubkey) ?? {
          pubkey: user.pubkey,
          ...spawnForPubkey(map, user.pubkey, index),
          vx: 0,
          vy: 0,
          facing: 'south' as const,
          updatedAt: timestamp,
        }, timestamp)
        const driftSeed = Number.parseInt(user.pubkey.slice(index, index + 4), 16)
        const angle = timestamp / (1800 + (driftSeed % 900)) + index
        const vx = Math.cos(angle) * 0.55
        const vy = Math.sin(angle * 0.8) * 0.5
        const x = current.x + vx * 28
        const y = current.y + vy * 28
        const distance = Math.hypot(x - current.x, y - current.y)

        this.publishPosition(user.pubkey, {
          startX: current.x,
          startY: current.y,
          endX: x,
          endY: y,
          speed: distance / 0.56,
        }, timestamp - 560)
      })
  }

  private addSeedUser(user: MockUser, index: number) {
    this.users.set(user.pubkey, {
      ...user,
      dmRelays: [this.relayUrl],
      readRelays: [this.relayUrl],
      writeRelays: [this.relayUrl],
    })
    const map = buildOfficeMap(this.groupId, demoUsers.length)
    const spawn = spawnForPubkey(map, user.pubkey, index)
    this.positions.set(user.pubkey, {
      pubkey: user.pubkey,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      facing: 'south',
      updatedAt: Date.now(),
    })
    this.recordActivity(user.pubkey, Date.now() - index * 3 * 60 * 1000)
  }

  private ensureKnownUser(pubkey: string) {
    if (this.users.has(pubkey)) return this.users.get(pubkey)!
    const user: MockUser = {
      pubkey,
      npub: npubForPubkey(pubkey),
      name: shortNpub(pubkey),
      role: this.memberPubkeys.has(pubkey) ? 'member' : 'participant',
      blossomServers: ['https://blossom.primal.net', 'https://cdn.satellite.earth'],
      dmRelays: [this.relayUrl],
      readRelays: [this.relayUrl],
      writeRelays: [this.relayUrl],
    }
    this.users.set(pubkey, user)
    return user
  }

  private signUserEvent(pubkey: string, kind: number, tags: string[][], content = '') {
    const user = this.ensureKnownUser(pubkey)
    const template = {
      kind,
      pubkey,
      created_at: now(),
      tags,
      content,
    }

    return user.secretKey ? sign(template, user.secretKey) : mockSignature(template)
  }

  private publishAdminEvent(pubkey: string, kind: number, tags: string[][], content = '', targetGroupId = this.groupId) {
    return this.publish(this.signUserEvent(pubkey, kind, [groupTag(targetGroupId), ...tags, ['client', 'nestr']], content.trim()))
  }

  private publishRelayModeration(kind: number, tags: string[][], content = '') {
    return this.publish(
      sign(
        {
          kind,
          pubkey: this.relayPubkey,
          created_at: now(),
          tags: [groupTag(this.groupId), ...tags],
          content,
        },
        this.relaySecret,
      ),
    )
  }

  private canModerate(pubkey: string, kind: number) {
    if (pubkey === this.relayPubkey) return true
    const roles = this.adminRoles.get(pubkey) ?? []
    if (roles.includes('admin')) return true
    if (roles.includes('moderator')) {
      return kind === NIP29_KINDS.removeUser || kind === NIP29_KINDS.deleteEvent
    }
    return false
  }

  private hasInviteCode(code: string) {
    return this.events.some(
      (event) => event.kind === NIP29_KINDS.createInvite && tagValue(event, 'code') === code,
    )
  }

  private applyModerationEvent(event: NestrEvent) {
    if (event.kind === NIP29_KINDS.putUser) {
      const pubkey = targetPubkey(event)
      if (!pubkey) return
      const roles = targetRoles(event)
      const user = this.ensureKnownUser(pubkey)
      this.memberPubkeys.add(pubkey)
      if (roles.length > 0) this.adminRoles.set(pubkey, roles)
      else this.adminRoles.delete(pubkey)
      user.role = roles.length > 0 ? `admin: ${roles.join(', ')}` : 'member'
      if (!this.positions.has(pubkey)) {
        const map = buildOfficeMap(this.groupId, this.users.size)
        const spawn = spawnForPubkey(map, pubkey, this.users.size)
        this.positions.set(pubkey, {
          pubkey,
          x: spawn.x,
          y: spawn.y,
          vx: 0,
          vy: 0,
          facing: 'south',
          updatedAt: Date.now(),
        })
      }
      this.refreshGroupStateEvents()
    }

    if (event.kind === NIP29_KINDS.removeUser) {
      const pubkey = targetPubkey(event)
      if (!pubkey) return
      this.memberPubkeys.delete(pubkey)
      this.adminRoles.delete(pubkey)
      this.positions.delete(pubkey)
      const user = this.users.get(pubkey)
      if (user) user.role = 'participant'
      this.refreshGroupStateEvents()
    }

    if (event.kind === NIP29_KINDS.editMetadata) {
      const draft = groupMetadataDraft({ tags: event.tags })
      this.group = {
        ...this.group,
        metadata: sign(
          {
            kind: NIP29_KINDS.groupMetadata,
            pubkey: this.relayPubkey,
            created_at: now(),
            tags: [
              ...metadataTags(this.groupId, draft, 'd'),
              ['office', '1'],
              ['office-map', 'nostr-office-v1'],
            ],
            content: '',
          },
          this.relaySecret,
        ),
      }
      this.relayGroupEvents.set(this.groupId, this.group.metadata)
    }

    if (event.kind === NIP29_KINDS.deleteEvent) {
      const eventId = targetEventId(event)
      if (eventId) this.deletedEventIds.add(eventId)
    }
  }

  private createGroup(groupId = this.groupId): Nip29Group {
    const metadata =
      this.relayGroupEvents.get(groupId) ??
      this.createGroupMetadata(groupId, 'Nestr Design Office', 'A relay-native spatial room')

    const admins = sign(
      {
        kind: NIP29_KINDS.groupAdmins,
        pubkey: this.relayPubkey,
        created_at: now(),
        tags: [
          dTag(groupId),
          ...Array.from(this.adminRoles.entries()).map(([pubkey, roles]) => ['p', pubkey, ...roles]),
        ],
        content: 'relay-generated admins',
      },
      this.relaySecret,
    )

    const members = sign(
      {
        kind: NIP29_KINDS.groupMembers,
        pubkey: this.relayPubkey,
        created_at: now(),
        tags: [dTag(groupId), ...Array.from(this.memberPubkeys).map((pubkey) => ['p', pubkey])],
        content: 'relay-generated members',
      },
      this.relaySecret,
    )

    const roles = sign(
      {
        kind: NIP29_KINDS.groupRoles,
        pubkey: this.relayPubkey,
        created_at: now(),
        tags: [
          dTag(groupId),
          ['role', 'admin', 'metadata, invites, moderation'],
          ['role', 'moderator', 'moderation'],
          ['role', 'builder', 'office map changes'],
        ],
        content: 'relay-supported roles',
      },
      this.relaySecret,
    )

    return { id: groupId, relay: this.relayUrl, metadata, admins, members, roles }
  }

  private createGroupMetadata(groupId: string, name = groupId, about = 'Created from Nestr'): NestrEvent {
    return sign(
      {
        kind: NIP29_KINDS.groupMetadata,
        pubkey: this.relayPubkey,
        created_at: now(),
        tags: [
          ...metadataTags(
            groupId,
            {
              name: name.trim() || groupId,
              about,
              picture: 'https://placehold.co/128x128/f4f1e9/171922?text=N',
              private: false,
              restricted: true,
              closed: false,
              hidden: false,
            },
            'd',
          ),
          ['office', '1'],
          ['office-map', 'nostr-office-v1'],
        ],
        content: '',
      },
      this.relaySecret,
    )
  }

  private refreshGroupStateEvents() {
    this.group = {
      ...this.group,
      admins: sign(
        {
          kind: NIP29_KINDS.groupAdmins,
          pubkey: this.relayPubkey,
          created_at: now(),
          tags: [
            dTag(this.groupId),
            ...Array.from(this.adminRoles.entries()).map(([pubkey, roles]) => ['p', pubkey, ...roles]),
          ],
          content: 'relay-generated admins',
        },
        this.relaySecret,
      ),
      members: sign(
        {
          kind: NIP29_KINDS.groupMembers,
          pubkey: this.relayPubkey,
          created_at: now(),
          tags: [dTag(this.groupId), ...Array.from(this.memberPubkeys).map((pubkey) => ['p', pubkey])],
          content: 'relay-generated members',
        },
        this.relaySecret,
      ),
    }
  }

  private seedMessages() {
    const lines = [
      [demoUsers[1], 'Design crit is live by the product desks.'],
      [demoUsers[2], 'Dropping the onboarding flow in the studio.'],
      [demoUsers[0], 'Wave when you get close, the mesh should light up.'],
    ] as const

    lines.forEach(([user, content], index) => {
      const event = sign(
        {
          kind: NIP29_KINDS.chatMessage,
          pubkey: user.pubkey,
          created_at: now() - (lines.length - index) * 60,
          tags: [groupTag(this.groupId), ['client', 'nestr']],
          content,
        },
        user.secretKey!,
      )

      this.events.push(event)
      this.seededEventIds.add(event.id)
      this.recordActivity(user.pubkey, event.created_at * 1000)
    })
  }

  private seedDirectMessages() {
    const self = demoUsers[0]
    const peer = demoUsers[1]
    const createdAt = now() - 120

    this.directMessages.push({
      id: bytesToHex(sha256(encoder.encode('seed-dm-brad-som'))),
      counterparty: peer.pubkey,
      senderPubkey: peer.pubkey,
      recipientPubkey: self.pubkey,
      content: 'Direct messages are encrypted in live mode. Mock mode keeps the thread readable.',
      createdAt,
      protocol: 'mock',
    })
    this.recordActivity(peer.pubkey, createdAt * 1000)
  }

  private recordActivity(pubkey: string, atMs = Date.now()) {
    const previous = this.activityAt.get(pubkey) ?? 0
    if (atMs > previous) this.activityAt.set(pubkey, atMs)
  }

  private emit(event?: NestrEvent) {
    const snapshot = this.snapshot()
    this.listeners.forEach((listener) => listener(snapshot, event))
  }
}

export function createMockRelay(options?: MockRelayOptions) {
  return new MockNip29Relay(options)
}
