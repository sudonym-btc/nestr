import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  Relay,
  SimplePool,
  type EventTemplate,
  type Filter,
  type VerifiedEvent,
} from 'nostr-tools'
import { npubForPubkey, shortNpub } from './avatar'
import {
  NIP29_KINDS,
  NIP51_KINDS,
  DM_KINDS,
  OFFICE_KINDS,
  groupTag,
  isEphemeralKind,
  tagValue,
  type NestrAttachment,
  type NestrDirectMessage,
  type NestrEvent,
  type NestrSigner,
} from './nostr'
import { parseSimpleGroupsEvent, type SimpleGroupPointer } from './nip51'
import {
  normalizeRelayUrl,
  relayGroupKey,
  relayUrlFromGroupEvent,
  sameRelayUrl,
  withRelayTag,
} from './relayDiscovery'
import { attachmentTags, contentWithAttachmentUrls } from './attachments'
import type { MockUser, Nip29Group, RelaySnapshot } from './mockRelay'
import {
  groupMetadataDraft,
  isNip29ModerationKind,
  metadataTags,
  pendingJoinRequests,
  targetEventId,
  targetPubkey,
  targetRoles,
  type Nip29MetadataDraft,
} from './nip29'
import { profilePubkeysFromReferences } from './nostrReferences'
import {
  blossomServersFromTags,
  buildProfilePictureCandidates,
  profileNameFromContent,
  profilePictureFromContent,
} from './profileImages'
import { cacheProfileMetadata, getCachedProfileMetadatas } from './profileMetadataCache'
import {
  createPositionPayload,
  isPositionFresh,
  parsePositionPayload,
  positionEventTime,
  POSITION_REBROADCAST_RESIGN_AFTER_MS,
  resolveWorldPosition,
  shouldApplyPositionUpdate,
  worldPositionFromPayload,
  type PositionMovement,
} from './positionEvents'
import { unwrapNip04DirectMessage } from './nip04'
import { createNip17DirectMessage, unwrapNip17DirectMessage } from './nip17'
import { ACTIVITY_KINDS, PRESENCE_WINDOW_MS } from './presence'
import type { WorldPosition } from './world'
import {
  contentSummary,
  debugDuration,
  debugError,
  debugLog,
  debugWarn,
  eventTagSummary,
  shortId,
} from './debugLog'

const encoder = new TextEncoder()
const GROUP_CHAT_KINDS = new Set([1, 9])
const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io']
const NIP65_RELAY_LIST_KIND = 10002
const PROFILE_FETCH_BATCH_SIZE = 80
const PROFILE_FETCH_BATCH_DELAY_MS = 320

interface PendingPositionPublish {
  pubkey: string
  movement: PositionMovement
  sentAt: number
}

function now() {
  return Math.floor(Date.now() / 1000)
}

function yieldToMainThread() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function isEventTooOldReason(reason: unknown) {
  return typeof reason === 'string' && reason.toLowerCase().includes('event too old')
}

function isOfficePositionKind(kind: number) {
  return kind === OFFICE_KINDS.avatarPosition
}

function normalizeRelayUrls(relays: string[]) {
  return Array.from(new Set(relays.map((relayUrl) => normalizeRelayUrl(relayUrl))))
}

function roomRelayCanRunHelperFilter(filter: Filter) {
  const tagFilters = filter as Record<string, unknown>
  if (Array.isArray(tagFilters['#h']) || Array.isArray(tagFilters['#e']) || Array.isArray(tagFilters['#a'])) return true
  if (!Array.isArray(tagFilters['#d'])) return false

  const kinds = filter.kinds ?? []
  return kinds.length > 0 && kinds.every((kind) => isRelayGeneratedGroupStateKind(kind))
}

function isRelayGeneratedGroupStateKind(kind: number) {
  return kind >= NIP29_KINDS.groupMetadata && kind <= NIP29_KINDS.groupRoles
}

function replaceableEventKey(event: NestrEvent) {
  if (event.kind < 30000 || event.kind >= 40000) return ''
  const d = tagValue(event, 'd')
  return d ? `${event.kind}:${event.pubkey}:${d}` : ''
}

function placeholderPubkey(value: string) {
  return bytesToHex(sha256(encoder.encode(value))).slice(0, 64)
}

function placeholderEvent(kind: number, pubkey: string, tags: string[][], content = ''): NestrEvent {
  const created_at = now()
  const id = bytesToHex(sha256(encoder.encode(JSON.stringify([kind, pubkey, tags, content, created_at]))))
  return {
    id,
    pubkey,
    created_at,
    kind,
    tags,
    content,
    sig: `placeholder-${id.slice(0, 16)}`,
  }
}

function withFallbackName(event: NestrEvent, fallbackName?: string | null) {
  const name = fallbackName?.trim()
  if (!name || tagValue(event, 'name')) return event
  return { ...event, tags: [...event.tags, ['name', name]] }
}

function userFromPubkey(pubkey: string, role = 'member'): MockUser {
  return {
    pubkey,
    npub: npubForPubkey(pubkey),
    name: shortNpub(pubkey),
    role,
  }
}

function relaysFromTags(tags: string[][], names = ['relay', 'r']) {
  return Array.from(
    new Set(
      tags
        .filter((tag) => names.includes(tag[0]) && /^wss:\/\//i.test(tag[1] ?? ''))
        .map((tag) => tag[1]),
    ),
  )
}

function readWriteRelaysFromTags(tags: string[][]) {
  const read: string[] = []
  const write: string[] = []

  tags
    .filter((tag) => tag[0] === 'r' && /^wss:\/\//i.test(tag[1] ?? ''))
    .forEach((tag) => {
      const marker = tag[2]
      if (marker === 'read') read.push(tag[1])
      else if (marker === 'write') write.push(tag[1])
      else {
        read.push(tag[1])
        write.push(tag[1])
      }
    })

  return {
    read: Array.from(new Set(read)),
    write: Array.from(new Set(write)),
  }
}

export function roleLabelFromState(roles: string[], isMember: boolean, isSelf = false) {
  if (roles.length > 0) return `admin: ${roles.join(', ')}`
  if (isMember) return 'member'
  if (isSelf) return 'signed in'
  return 'participant'
}

function relayAuthSigner(signer: NestrSigner) {
  return async (event: EventTemplate): Promise<VerifiedEvent> =>
    (await signer.signEvent(event)) as unknown as VerifiedEvent
}

function isOfficeCallSignalKind(kind: number) {
  return (
    kind === OFFICE_KINDS.callOffer ||
    kind === OFFICE_KINDS.callAnswer ||
    kind === OFFICE_KINDS.iceCandidate ||
    kind === OFFICE_KINDS.callHangup ||
    kind === OFFICE_KINDS.callRenegotiate
  )
}

function callSignalParticipants(payload: unknown) {
  if (!payload || typeof payload !== 'object') return []
  const participants = (payload as { participants?: unknown }).participants
  if (!Array.isArray(participants)) return []
  return Array.from(new Set(participants.filter((pubkey): pubkey is string => typeof pubkey === 'string' && pubkey.length > 0)))
}

export function directMessageSubscriptionFilters(pubkey: string): Filter[] {
  return [
    { kinds: [DM_KINDS.giftWrap], '#p': [pubkey], limit: 120 },
    { kinds: [DM_KINDS.legacyDirectMessage], '#p': [pubkey], limit: 120 },
    { kinds: [DM_KINDS.legacyDirectMessage], authors: [pubkey], limit: 120 },
  ]
}

export class LiveNip29Relay {
  readonly mode = 'live' as const
  readonly relayUrl: string
  readonly groupId: string
  readonly hasSelectedGroup: boolean

  private readonly listeners = new Set<(snapshot: RelaySnapshot, event?: NestrEvent) => void>()
  private profilePool = new SimplePool({ enableReconnect: true })
  private readonly events = new Map<string, NestrEvent>()
  private readonly directMessages = new Map<string, NestrDirectMessage>()
  private readonly relayGroups = new Map<string, NestrEvent>()
  private readonly positions = new Map<string, WorldPosition>()
  private readonly users = new Map<string, MockUser>()
  private readonly profiles = new Map<string, NestrEvent>()
  private readonly blossomServers = new Map<string, string[]>()
  private readonly dmRelays = new Map<string, string[]>()
  private readonly dmRelayEvents = new Map<string, NestrEvent>()
  private readonly relayListEvents = new Map<string, NestrEvent>()
  private readonly simpleGroupListEvents = new Map<string, NestrEvent>()
  private readonly savedRelayUrls = new Set<string>()
  private readonly readRelays = new Map<string, string[]>()
  private readonly writeRelays = new Map<string, string[]>()
  private readonly activityAt = new Map<string, number>()
  private readonly memberPubkeys = new Set<string>()
  private readonly adminRoles = new Map<string, string[]>()
  private readonly deletedEventIds = new Set<string>()
  private readonly profileQueue = new Set<string>()
  private readonly timelineRefs: string[] = []
  private relay?: Relay
  private groupSub?: ReturnType<Relay['subscribe']>
  private dmSub?: ReturnType<Relay['subscribe']>
  private readonly dmRelaySubs: ReturnType<SimplePool['subscribe']>[] = []
  private presenceSub?: ReturnType<SimplePool['subscribe']>
  private profileFetchTimer?: ReturnType<typeof setTimeout>
  private roomAccessTimer?: ReturnType<typeof setTimeout>
  private group: Nip29Group
  private signer?: NestrSigner
  private connectionStatus: RelaySnapshot['connectionStatus'] = 'connecting'
  private connectionMessage = 'connecting to live relay'
  private readonly connectionLog: string[] = ['connecting to live relay']
  private roomAccessStatus: RelaySnapshot['roomAccessStatus'] = 'unknown'
  private roomAccessMessage = 'room not checked yet'
  private positionPublishInFlight = false
  private pendingPositionPublish?: PendingPositionPublish
  private positionPublishVersion = 0
  private lastSignedPositionEvent?: NestrEvent
  private connectPromise?: Promise<void>
  private connectGeneration = 0
  private closed = false

  constructor(groupId: string | undefined, relayUrl: string, groupNameHint = '') {
    this.groupId = groupId ?? ''
    this.hasSelectedGroup = Boolean(groupId)
    this.relayUrl = normalizeRelayUrl(relayUrl)
    this.savedRelayUrls.add(this.relayUrl)
    const relayPubkey = placeholderPubkey(`relay:${this.relayUrl}`)
    const placeholderGroupId = groupId ?? 'relay-directory'
    const placeholderName = groupNameHint.trim() || (groupId ? 'Live Chatroom' : 'Relay Directory')
    this.group = {
      id: placeholderGroupId,
      relay: this.relayUrl,
      metadata: placeholderEvent(39000, relayPubkey, [
        ['d', placeholderGroupId],
        ['name', placeholderName],
        ['about', groupId ? `${groupId} on ${this.relayUrl}` : `Chatrooms on ${this.relayUrl}`],
        ['relay', this.relayUrl],
        ['restricted'],
        ['office', '1'],
      ]),
      admins: placeholderEvent(39001, relayPubkey, [['d', placeholderGroupId]], 'relay admins pending'),
      members: placeholderEvent(39002, relayPubkey, [['d', placeholderGroupId]], 'relay members pending'),
      roles: placeholderEvent(39003, relayPubkey, [['d', placeholderGroupId]], 'relay roles pending'),
    }
    if (groupId) this.relayGroups.set(relayGroupKey(this.relayUrl, groupId), this.group.metadata)
  }

  snapshot(): RelaySnapshot {
    const events = Array.from(this.events.values())
    const messages = events
      .filter((event) => GROUP_CHAT_KINDS.has(event.kind))
      .filter((event) => !this.deletedEventIds.has(event.id))
      .sort((a, b) => a.created_at - b.created_at)
    const moderationEvents = events
      .filter((event) => isNip29ModerationKind(event.kind))
      .sort((a, b) => b.created_at - a.created_at)

    return {
      mode: this.mode,
      connectionStatus: this.connectionStatus,
      connectionMessage: this.connectionMessage,
      connectionLog: this.connectionLog,
      roomAccessStatus: this.roomAccessStatus,
      roomAccessMessage: this.roomAccessMessage,
      relayUrls: Array.from(this.savedRelayUrls).sort((a, b) => a.localeCompare(b)),
      group: this.group,
      relayGroups: Array.from(this.relayGroups.values()).sort((a, b) =>
        `${relayUrlFromGroupEvent(a, this.relayUrl)} ${tagValue(a, 'name') ?? tagValue(a, 'd') ?? ''}`.localeCompare(
          `${relayUrlFromGroupEvent(b, this.relayUrl)} ${tagValue(b, 'name') ?? tagValue(b, 'd') ?? ''}`,
        ),
      ),
      users: Array.from(this.users.values()),
      messages,
      directMessages: Array.from(this.directMessages.values()).sort((a, b) => a.createdAt - b.createdAt),
      joinRequests: pendingJoinRequests(events, this.memberPubkeys),
      moderationEvents,
      invites: events.filter((event) => event.kind === NIP29_KINDS.createInvite),
      deletedEventIds: Array.from(this.deletedEventIds),
      positions: Array.from(this.positions.values())
        .filter((position) => isPositionFresh(position))
        .map((position) => resolveWorldPosition(position)),
      presence: Object.fromEntries(this.activityAt),
      eventCount: this.events.size,
    }
  }

  subscribe(listener: (snapshot: RelaySnapshot, event?: NestrEvent) => void) {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  setSigner(signer: NestrSigner) {
    if (this.closed) return
    debugLog('relay', 'setSigner', {
      pubkey: shortId(signer.pubkey),
      label: signer.label,
      relay: this.relayUrl,
      relayConnected: Boolean(this.relay),
    })
    this.signer = signer
    if (this.relay) this.relay.onauth = relayAuthSigner(signer)
    this.upsertUser(signer.pubkey)
    this.queueProfileFetch([signer.pubkey])
    this.recordActivity(signer.pubkey)
    this.setConnection(this.connectionStatus, 'Account connected')
    this.refreshDirectMessageSubscriptions()
    this.emit()
    void this.authenticateAndRefetch()
    void this.fetchSavedSimpleGroups(signer.pubkey)
  }

  clearSigner() {
    if (this.closed) return
    debugWarn('relay', 'clearSigner', { pubkey: shortId(this.signer?.pubkey), relay: this.relayUrl })
    this.signer = undefined
    if (this.relay) this.relay.onauth = undefined
    this.dmSub?.close()
    this.dmSub = undefined
    this.closeDmRelaySubs()
    this.setConnection(this.connectionStatus, 'Account disconnected')
    this.emit()
  }

  refreshDirectMessageSubscriptions() {
    if (this.closed) return
    debugLog('dm', 'refreshDirectMessageSubscriptions', {
      signer: shortId(this.signer?.pubkey),
      relay: this.relayUrl,
      hadRoomSub: Boolean(this.dmSub),
      extraRelaySubs: this.dmRelaySubs.length,
    })
    this.dmSub?.close()
    this.dmSub = undefined
    this.closeDmRelaySubs()
    this.openDmSubscription()
  }

  joinWithNpub(value: string) {
    const pubkey = placeholderPubkey(`watch:${value}`)
    const user = userFromPubkey(pubkey, 'watching')
    this.users.set(pubkey, user)
    this.emit()
    return user
  }

  async publishGroupMessage(pubkey: string, content: string, attachments: NestrAttachment[] = []) {
    const trimmed = content.trim()
    if (!this.hasSelectedGroup) return { ok: false, reason: 'group-required' }
    if ((!trimmed && attachments.length === 0) || !this.signer || this.signer.pubkey !== pubkey || !this.relay) {
      return { ok: false, reason: 'live-signer-required' }
    }

    const event = await this.signer.signEvent({
      kind: 9,
      created_at: now(),
      tags: [groupTag(this.groupId), ...this.previousTags(), ...attachmentTags(attachments), ['client', 'nestr']],
      content: contentWithAttachmentUrls(trimmed, attachments),
    })

    return this.publishSigned(event)
  }

  async publishDirectMessage(
    pubkey: string,
    recipientPubkey: string,
    content: string,
    attachments: NestrAttachment[] = [],
  ) {
    const trimmed = content.trim()
    debugLog('dm', 'publishDirectMessage start', {
      pubkey: shortId(pubkey),
      recipient: shortId(recipientPubkey),
      textBytes: trimmed.length,
      attachments: attachments.length,
    })
    if ((!trimmed && attachments.length === 0) || !this.signer || this.signer.pubkey !== pubkey || !this.relay) {
      debugWarn('dm', 'publishDirectMessage blocked', {
        pubkey: shortId(pubkey),
        hasSigner: Boolean(this.signer),
        signer: shortId(this.signer?.pubkey),
        hasRelay: Boolean(this.relay),
      })
      return { ok: false, reason: 'live-signer-required' }
    }

    try {
      const recipientRelayUrls = await this.fetchDmRelays(recipientPubkey)
      debugLog('dm', 'recipient relay lookup done', {
        recipient: shortId(recipientPubkey),
        relays: recipientRelayUrls,
      })
      if (recipientRelayUrls.length === 0) {
        const reason = 'recipient-nip17-relays-missing'
        this.setConnection(this.connectionStatus, `${shortNpub(recipientPubkey)} has not published NIP-17 DM relays`)
        this.emit()
        return { ok: false, reason }
      }

      const senderRelayUrls =
        recipientPubkey === pubkey ? recipientRelayUrls : await this.fetchDmRelays(pubkey)
      debugLog('dm', 'sender relay lookup done', {
        sender: shortId(pubkey),
        relays: senderRelayUrls,
      })
      const createdAt = now()
      const envelopes: NestrEvent[] = []
      let firstEvent: NestrEvent | undefined

      if (trimmed) {
        const { message, wraps } = await createNip17DirectMessage(this.signer, recipientPubkey, trimmed, createdAt)
        this.directMessages.set(message.id, message)
        envelopes.push(...wraps)
        firstEvent = wraps[0]
      }

      for (const [index, attachment] of attachments.entries()) {
        const { message, wraps } = await createNip17DirectMessage(
          this.signer,
          recipientPubkey,
          '',
          createdAt + index + 1,
          { attachment },
        )
        this.directMessages.set(message.id, message)
        envelopes.push(...wraps)
        firstEvent ??= wraps[0]
      }

      this.upsertUser(recipientPubkey)
      this.queueProfileFetch([recipientPubkey])
      this.recordActivity(pubkey, createdAt * 1000)
      this.emit()

      for (const wrap of envelopes) {
        const wrappedRecipient = tagValue(wrap, 'p')
        if (wrappedRecipient === pubkey && recipientPubkey !== pubkey && senderRelayUrls.length === 0) continue
        const publishRelays = wrappedRecipient === pubkey && senderRelayUrls.length > 0
          ? senderRelayUrls
          : recipientRelayUrls
        await this.publishToRelays(wrap, publishRelays)
      }

      return { ok: true, event: firstEvent }
    } catch (error) {
      debugError('dm', 'publishDirectMessage failed', { error: error instanceof Error ? error.message : String(error) })
      this.setConnection(this.connectionStatus, error instanceof Error ? error.message : String(error))
      this.emit()
      return { ok: false, reason: this.connectionMessage }
    }
  }

  async publishPosition(
    pubkey: string,
    movement: PositionMovement,
    sentAt = Date.now(),
  ) {
    if (!this.hasSelectedGroup) return { ok: false, reason: 'group-required' }
    if (!this.signer || this.signer.pubkey !== pubkey || !this.relay) {
      return { ok: false, reason: 'live-signer-required' }
    }
    const metadata = groupMetadataDraft(this.group.metadata)
    const isMember = this.memberPubkeys.has(pubkey) || this.adminRoles.has(pubkey)
    if (metadata.private && !isMember) return { ok: false, reason: 'private: membership required to enter office' }
    if (metadata.restricted && !isMember) return { ok: false, reason: 'restricted: membership required to enter office' }

    const payload = createPositionPayload(movement, sentAt)
    this.positions.set(
      pubkey,
      worldPositionFromPayload(
        pubkey,
        { id: `local:${sentAt}`, created_at: Math.floor(sentAt / 1000) },
        parsePositionPayload(payload),
        Date.now(),
      ),
    )
    this.emit()

    const version = ++this.positionPublishVersion
    if (this.positionPublishInFlight) {
      this.pendingPositionPublish = {
        pubkey,
        movement,
        sentAt,
      }
      debugWarn('position', 'position publish superseded in-flight request', {
        pubkey: shortId(pubkey),
        version,
        pendingSentAt: sentAt,
        movement,
      })
      return { ok: false, reason: 'position-publish-queued' }
    }

    return this.publishPositionRequest(pubkey, movement, sentAt, version)
  }

  private async publishPositionRequest(
    pubkey: string,
    movement: PositionMovement,
    sentAt: number,
    version: number,
  ) {
    this.positionPublishInFlight = true
    const template = {
      kind: OFFICE_KINDS.avatarPosition,
      created_at: now(),
      tags: [
        groupTag(this.groupId),
        ['relay', this.relayUrl],
        ['client', 'nestr'],
      ],
      content: createPositionPayload(movement, sentAt),
    }

    try {
      const signStartedAt = performance.now()
      debugLog('position', 'sign template start', {
        kind: template.kind,
        version,
        pubkey: shortId(pubkey),
        tags: eventTagSummary(template.tags),
        content: contentSummary(template.kind, template.content),
      })
      const event = await this.signer!.signEvent(template)
      debugLog('position', 'sign template resolved', {
        kind: template.kind,
        version,
        id: shortId(event.id),
        elapsedMs: debugDuration(signStartedAt),
      })
      if (version !== this.positionPublishVersion) {
        debugWarn('position', 'discarding stale signed position event', {
          kind: event.kind,
          id: shortId(event.id),
          version,
          latestVersion: this.positionPublishVersion,
        })
        return { ok: false, reason: 'stale-position-discarded' }
      }
      this.lastSignedPositionEvent = event
      const result = await this.publishSigned(event, false)
      if (version !== this.positionPublishVersion) {
        debugWarn('position', 'published position was superseded before ack', {
          kind: event.kind,
          id: shortId(event.id),
          version,
          latestVersion: this.positionPublishVersion,
        })
        return { ok: false, reason: 'stale-position-discarded' }
      }
      debugLog('position', 'publishSigned result', {
        kind: template.kind,
        version,
        id: shortId(event.id),
        ok: result.ok,
        reason: result.ok ? undefined : result.reason,
      })
      return result
    } catch (error) {
      debugError('position', 'sign or publish failed', {
        version,
        error: error instanceof Error ? error.message : String(error),
      })
      this.setConnection(this.connectionStatus, error instanceof Error ? error.message : String(error))
      this.emit()
      return { ok: false, reason: this.connectionMessage }
    } finally {
      this.positionPublishInFlight = false
      const pending = this.pendingPositionPublish
      this.pendingPositionPublish = undefined
      if (pending) {
        debugLog('position', 'flushing latest queued position publish', {
          pubkey: shortId(pending.pubkey),
          queuedForMs: Date.now() - pending.sentAt,
        })
        void this.publishPosition(pending.pubkey, pending.movement, pending.sentAt)
      }
    }
  }

  async republishLastPosition(pubkey: string) {
    if (!this.hasSelectedGroup) return { ok: false, reason: 'group-required' }
    if (!this.signer || this.signer.pubkey !== pubkey || !this.relay) {
      return { ok: false, reason: 'live-signer-required' }
    }
    if (this.positionPublishInFlight || this.pendingPositionPublish) {
      return { ok: false, reason: 'position-signing-in-flight' }
    }

    const event = this.lastSignedPositionEvent
    if (!event || event.pubkey !== pubkey || !isOfficePositionKind(event.kind)) {
      return { ok: false, reason: 'position-refresh-missing' }
    }
    const eventAgeMs = Date.now() - event.created_at * 1000
    if (eventAgeMs >= POSITION_REBROADCAST_RESIGN_AFTER_MS) {
      debugLog('position', 'last signed position needs fresh signature', {
        kind: event.kind,
        id: shortId(event.id),
        pubkey: shortId(pubkey),
        eventAgeMs,
        resignAfterMs: POSITION_REBROADCAST_RESIGN_AFTER_MS,
      })
      return { ok: false, reason: 'position-refresh-needs-signature' }
    }

    debugLog('position', 'republish last signed position', {
      kind: event.kind,
      id: shortId(event.id),
      pubkey: shortId(pubkey),
      createdAt: event.created_at,
      content: contentSummary(event.kind, event.content),
    })
    const result = await this.publishSigned(event, false)
    if (!result.ok && isEventTooOldReason(result.reason)) {
      if (this.lastSignedPositionEvent?.id === event.id) this.lastSignedPositionEvent = undefined
      debugLog('position', 'cached position rejected as too old; needs fresh signature', {
        kind: event.kind,
        id: shortId(event.id),
        pubkey: shortId(pubkey),
        reason: result.reason,
      })
      return { ok: false, reason: 'position-refresh-needs-signature' }
    }
    if (result.ok) {
      try {
        const payload = parsePositionPayload(event.content)
        this.positions.set(pubkey, worldPositionFromPayload(pubkey, event, payload))
      } catch {
        // Position refreshes should already be well-formed signed events.
      }
      this.recordActivity(pubkey)
      this.emit(event)
    }
    return result
  }

  async publishJoinRequest(pubkey: string, content = '', code = '') {
    const tags = code.trim() ? [['code', code.trim()]] : []
    return this.publishNip29Event(pubkey, NIP29_KINDS.joinRequest, tags, content, false, false)
  }

  async publishLeaveRequest(pubkey: string, content = '') {
    return this.publishNip29Event(pubkey, NIP29_KINDS.leaveRequest, [], content, false, false)
  }

  async publishPutUser(pubkey: string, target: string, roles: string[] = [], content = '') {
    return this.publishNip29Event(pubkey, NIP29_KINDS.putUser, [['p', target, ...roles]], content, false)
  }

  async publishRemoveUser(pubkey: string, target: string, content = '') {
    return this.publishNip29Event(pubkey, NIP29_KINDS.removeUser, [['p', target]], content, false)
  }

  async publishEditMetadata(pubkey: string, draft: Nip29MetadataDraft, content = '', targetGroupId = this.groupId) {
    return this.publishNip29Event(
      pubkey,
      NIP29_KINDS.editMetadata,
      metadataTags(targetGroupId, draft).slice(1),
      content,
      false,
      true,
      targetGroupId,
    )
  }

  async publishDeleteEvent(pubkey: string, eventId: string, content = '') {
    return this.publishNip29Event(pubkey, NIP29_KINDS.deleteEvent, [['e', eventId]], content, false)
  }

  async publishCreateGroup(pubkey: string, content = '', targetGroupId = this.groupId) {
    const groupId = targetGroupId.trim()
    if (!groupId) return { ok: false, reason: 'chatroom-id-required' }
    if (!this.signer || this.signer.pubkey !== pubkey || !this.relay) {
      return { ok: false, reason: 'live-signer-required' }
    }

    const label = content.trim() || groupId
    let event: NestrEvent
    try {
      event = await this.signer.signEvent({
        kind: NIP29_KINDS.createGroup,
        created_at: now(),
        tags: [groupTag(groupId), ['name', label], ['client', 'nestr']],
        content: label,
      })
    } catch (error) {
      this.setConnection(this.connectionStatus, error instanceof Error ? error.message : String(error))
      this.emit()
      return { ok: false, reason: this.connectionMessage }
    }

    const result = await this.publishSigned(event, false)
    if (result.ok) {
      this.relayGroups.set(
        relayGroupKey(this.relayUrl, groupId),
        placeholderEvent(39000, this.signer.pubkey, [
          ['d', groupId],
          ['name', label],
          ['about', `Created on ${this.relayUrl}`],
          ['relay', this.relayUrl],
        ]),
      )
      this.emit()
    }
    return result
  }

  async publishDeleteGroup(pubkey: string, content = '') {
    return this.publishNip29Event(pubkey, NIP29_KINDS.deleteGroup, [], content, false)
  }

  async publishCallSignal(pubkey: string, kind: number, targetPubkey: string, payload: unknown) {
    debugLog('call', 'publishCallSignal start', {
      kind,
      pubkey: shortId(pubkey),
      targetPubkey: shortId(targetPubkey),
    })
    if (!this.hasSelectedGroup) return { ok: false, reason: 'group-required' }
    if (!this.signer || this.signer.pubkey !== pubkey || !this.relay) {
      return { ok: false, reason: 'live-signer-required' }
    }

    if (!isOfficeCallSignalKind(kind)) {
      return { ok: false, reason: 'unsupported-call-signal' }
    }

    let event: NestrEvent
    try {
      const signStartedAt = performance.now()
      event = await this.signer.signEvent({
        kind,
        created_at: now(),
        tags: [
          groupTag(this.groupId),
          ['p', targetPubkey],
          ...callSignalParticipants(payload)
            .filter((participant) => participant !== targetPubkey && participant !== pubkey)
            .map((participant) => ['p', participant]),
          ['client', 'nestr'],
        ],
        content: JSON.stringify(payload),
      })
      debugLog('call', 'call signal signed', {
        kind,
        id: shortId(event.id),
        elapsedMs: debugDuration(signStartedAt),
      })
    } catch (error) {
      debugError('call', 'call signal sign failed', {
        kind,
        error: error instanceof Error ? error.message : String(error),
      })
      this.setConnection(this.connectionStatus, error instanceof Error ? error.message : String(error))
      this.emit()
      return { ok: false, reason: this.connectionMessage }
    }

    return this.publishSigned(event, false)
  }

  async publishCreateInvite(pubkey: string, code: string, content = '') {
    const trimmed = code.trim()
    if (!trimmed) return { ok: false, reason: 'invite-code-required' }
    return this.publishNip29Event(pubkey, NIP29_KINDS.createInvite, [['code', trimmed]], content, false)
  }

  tickBots() {
    // Live relays supply movement; the client does not fabricate people in live mode.
  }

  start() {
    if (this.relay || (!this.closed && this.connectPromise)) return
    this.closed = false
    this.connectGeneration += 1
    const generation = this.connectGeneration
    this.profilePool = new SimplePool({ enableReconnect: true })
    this.setConnection('connecting', 'connecting to live relay')
    this.connectPromise = this.connect(generation).finally(() => {
      if (this.connectGeneration === generation) this.connectPromise = undefined
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.connectGeneration += 1
    this.connectPromise = undefined
    this.groupSub?.close()
    this.dmSub?.close()
    this.closeDmRelaySubs()
    this.presenceSub?.close()
    if (this.roomAccessTimer) clearTimeout(this.roomAccessTimer)
    this.roomAccessTimer = undefined
    if (this.profileFetchTimer) clearTimeout(this.profileFetchTimer)
    this.profilePool.destroy()
    this.relay?.close()
    this.relay = undefined
  }

  private recordConnectionMessage(message: string) {
    this.connectionLog.unshift(`${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${message}`)
    this.connectionLog.splice(8)
  }

  private setConnection(status: RelaySnapshot['connectionStatus'], message: string) {
    this.connectionStatus = status
    this.connectionMessage = message
    this.recordConnectionMessage(message)
  }

  private setRoomAccess(status: NonNullable<RelaySnapshot['roomAccessStatus']>, message: string) {
    this.roomAccessStatus = status
    this.roomAccessMessage = message
    this.connectionMessage = message
    this.recordConnectionMessage(message)
  }

  private markRoomAccessOpen(message = this.hasSelectedGroup ? 'room subscription open' : 'relay directory open') {
    if (this.roomAccessTimer) clearTimeout(this.roomAccessTimer)
    this.roomAccessTimer = undefined
    this.roomAccessStatus = 'open'
    this.roomAccessMessage = message
  }

  private async connect(generation: number) {
    try {
      const relay = await Relay.connect(this.relayUrl, { enableReconnect: true })
      if (this.closed || this.connectGeneration !== generation) {
        relay.close()
        return
      }
      this.relay = relay
      relay.onnotice = (message) => {
        this.setConnection(this.connectionStatus, `relay notice: ${message}`)
        this.emit()
      }
      relay.onclose = () => {
        if (this.closed) return
        this.setConnection('disconnected', 'relay socket closed')
        this.emit()
      }
      this.setConnection('connected', 'live relay connected')
      if (this.signer) relay.onauth = relayAuthSigner(this.signer)

      this.openGroupSubscription()
      this.openDmSubscription()
      if (this.signer) void this.authenticateAndRefetch()
      this.emit()
    } catch (error) {
      this.setConnection('error', error instanceof Error ? error.message : String(error))
      this.emit()
    }
  }

  private openGroupSubscription() {
    if (this.closed || !this.relay) return

    this.groupSub?.close()
    if (this.roomAccessTimer) clearTimeout(this.roomAccessTimer)
    this.roomAccessTimer = undefined

    const filters: Filter[] = this.hasSelectedGroup
      ? [
        { kinds: [39000, 39001, 39002, 39003], '#d': [this.groupId], limit: 32 },
        { kinds: [OFFICE_KINDS.avatarPosition], '#h': [this.groupId], limit: 256 },
        { '#h': [this.groupId], limit: 180 },
      ]
      : [{ kinds: [39000], limit: 240 }]

    this.roomAccessTimer = setTimeout(() => {
      if (this.closed || this.roomAccessStatus !== 'unknown') return
      debugWarn('relay', 'room subscription did not EOSE; opening after grace period', {
        relay: this.relayUrl,
        groupId: this.hasSelectedGroup ? this.groupId : undefined,
      })
      this.markRoomAccessOpen(this.hasSelectedGroup ? 'room subscription active' : 'relay directory active')
      this.emit()
    }, 5000)

    try {
      this.groupSub = this.relay.subscribe(filters, {
        onevent: (event) => {
          if (this.closed) return
          if (this.roomAccessStatus === 'unknown') {
            this.markRoomAccessOpen(this.hasSelectedGroup ? 'room subscription receiving events' : 'relay directory receiving events')
          }
          this.receive(event as NestrEvent)
        },
        onclose: (reason) => {
          if (this.closed) return
          if (this.roomAccessTimer) clearTimeout(this.roomAccessTimer)
          this.roomAccessTimer = undefined
          const message = reason?.trim() || 'room subscription closed'
          if (message === 'closed by caller') return

          if (message.startsWith('auth-required')) {
            this.setRoomAccess('auth-required', this.signer ? 'room requested auth' : message)
            this.emit()
            if (this.signer) void this.authenticateAndRefetch()
            return
          }

          this.setRoomAccess(message.startsWith('blocked') ? 'blocked' : 'closed', message)
          this.emit()
        },
        oneose: () => {
          if (this.closed) return
          this.markRoomAccessOpen()
          this.emit()
        },
        eoseTimeout: 3500,
      })
    } catch (error) {
      if (this.closed) return
      if (this.roomAccessTimer) clearTimeout(this.roomAccessTimer)
      this.roomAccessTimer = undefined
      debugWarn('relay', 'group subscription failed', {
        relay: this.relayUrl,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private openDmSubscription() {
    if (this.closed || !this.relay || !this.signer) return

    this.dmSub?.close()
    try {
      this.dmSub = this.relay.subscribe(
        directMessageSubscriptionFilters(this.signer.pubkey),
        {
          onevent: (event) => {
            if (!this.closed) void this.receiveDirectMessage(event as NestrEvent)
          },
          onclose: (reason) => {
            if (this.closed) return
            if (reason?.startsWith('auth-required') && this.signer) {
              this.setConnection(this.connectionStatus, 'relay requested auth for direct messages')
              this.emit()
              void this.authenticateAndRefetch()
            }
          },
          eoseTimeout: 3500,
        },
      )
    } catch (error) {
      if (this.closed) return
      debugWarn('dm', 'room DM subscription failed', {
        relay: this.relayUrl,
        signer: shortId(this.signer.pubkey),
        message: error instanceof Error ? error.message : String(error),
      })
      this.dmSub = undefined
      return
    }
    void this.openDmRelaySubscriptions()
  }

  private async openDmRelaySubscriptions() {
    if (this.closed || !this.signer) return
    const signer = this.signer
    this.closeDmRelaySubs()

    const [nip17Relays, legacyReadRelays] = await Promise.all([
      this.fetchDmRelays(signer.pubkey),
      this.fetchLegacyDmReadRelays(signer.pubkey),
    ])
    if (this.closed || this.signer !== signer) return
    const relayUrls = Array.from(new Set([...nip17Relays, ...legacyReadRelays])).filter((url) => url !== this.relayUrl)
    if (relayUrls.length === 0) return

    directMessageSubscriptionFilters(signer.pubkey).forEach((filter) => {
      try {
        const sub = this.profilePool.subscribe(relayUrls, filter, {
          onevent: (event) => {
            if (!this.closed) void this.receiveDirectMessage(event as NestrEvent)
          },
          onauth: relayAuthSigner(signer),
          eoseTimeout: 3500,
        })
        this.dmRelaySubs.push(sub)
      } catch (error) {
        if (this.closed) return
        debugWarn('dm', 'extra relay DM subscription failed', {
          signer: shortId(signer.pubkey),
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  private closeDmRelaySubs() {
    this.dmRelaySubs.splice(0).forEach((sub) => sub.close())
  }

  private queryRoomRelay(filters: Filter[], maxWait: number) {
    if (this.closed || !this.relay) return Promise.resolve([] as NestrEvent[])
    const relay = this.relay

    return new Promise<NestrEvent[]>((resolve) => {
      const events: NestrEvent[] = []
      let done = false
      let sub: ReturnType<Relay['subscribe']> | undefined
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        sub?.close()
        resolve(events)
      }
      const timer = setTimeout(finish, maxWait)

      try {
        sub = relay.subscribe(filters, {
          onevent: (event) => {
            if (!this.closed) events.push(event as NestrEvent)
          },
          oneose: finish,
          onclose: finish,
          eoseTimeout: maxWait,
        })
      } catch {
        finish()
      }
    })
  }

  private async queryRelays(relays: string[], filter: Filter, maxWait: number) {
    const normalized = normalizeRelayUrls(relays)
    const includeRoomRelay =
      roomRelayCanRunHelperFilter(filter) && normalized.some((relayUrl) => sameRelayUrl(relayUrl, this.relayUrl))
    const helperRelays = normalized.filter((relayUrl) => !sameRelayUrl(relayUrl, this.relayUrl))
    const queries: Array<Promise<NestrEvent[]>> = []

    if (includeRoomRelay) queries.push(this.queryRoomRelay([filter], maxWait))
    if (helperRelays.length > 0) {
      queries.push(
        this.profilePool.querySync(helperRelays, filter, { maxWait }) as Promise<NestrEvent[]>,
      )
    }

    const settled = await Promise.allSettled(queries)
    return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  }

  private refreshPresenceSubscription() {
    if (this.closed) return
    const authors = Array.from(new Set([...this.memberPubkeys, ...this.adminRoles.keys()]))
      .filter((pubkey) => /^[0-9a-f]{64}$/i.test(pubkey))
      .sort()
    this.presenceSub?.close()
    this.presenceSub = undefined
    if (authors.length === 0) return

    const relays = normalizeRelayUrls(PROFILE_RELAYS)
    const since = Math.floor((Date.now() - PRESENCE_WINDOW_MS) / 1000)
    if (relays.length === 0) return
    try {
      this.presenceSub = this.profilePool.subscribe(
        relays,
        { kinds: ACTIVITY_KINDS, authors, since, limit: authors.length * 4 },
        {
          onevent: (event) => {
            if (this.closed) return
            this.recordActivity(event.pubkey, event.created_at * 1000)
            this.emit()
          },
          eoseTimeout: 3500,
        },
      )
    } catch (error) {
      if (this.closed) return
      debugWarn('relay', 'presence subscription failed', {
        relay: this.relayUrl,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async authenticateAndRefetch() {
    if (this.closed || !this.relay || !this.signer) return
    const signer = this.signer
    const startedAt = performance.now()
    debugLog('relay-auth', 'authenticateAndRefetch start', {
      signer: shortId(signer.pubkey),
      relay: this.relayUrl,
    })

    try {
      await this.relay.auth(relayAuthSigner(signer))
      if (this.closed || this.signer !== signer) return
      debugLog('relay-auth', 'relay auth ok', {
        signer: shortId(signer.pubkey),
        elapsedMs: debugDuration(startedAt),
      })
      this.setConnection('authenticated', `relay authenticated as ${shortNpub(signer.pubkey)}`)
      this.openGroupSubscription()
    } catch (error) {
      if (this.closed || this.signer !== signer) return
      const message = error instanceof Error ? error.message : String(error)
      const details = {
        signer: shortId(signer.pubkey),
        elapsedMs: debugDuration(startedAt),
        message,
      }
      if (message.includes('no challenge') || message.includes('auth timed out')) {
        debugLog('relay-auth', 'relay auth unavailable', details)
        this.setConnection('connected', 'signer connected; relay has not sent an auth challenge')
      } else {
        debugWarn('relay-auth', 'relay auth failed', details)
        this.setConnection('connected', `relay auth failed: ${message}`)
      }
    }

    if (!this.closed && this.signer === signer) this.refreshDirectMessageSubscriptions()
    this.emit()
  }

  private async publishSigned(event: NestrEvent, optimistic = true) {
    if (optimistic) this.receive(event)
    const isPositionEvent = isOfficePositionKind(event.kind)
    const startedAt = performance.now()
    debugLog('relay', 'publish start', {
      kind: event.kind,
      id: shortId(event.id),
      pubkey: shortId(event.pubkey),
      optimistic,
      isPositionEvent,
      tags: eventTagSummary(event.tags),
      content: contentSummary(event.kind, event.content),
    })
    try {
      const reason = await this.relay!.publish(event)
      debugLog('relay', 'publish ok', {
        kind: event.kind,
        id: shortId(event.id),
        elapsedMs: debugDuration(startedAt),
        reason,
      })
      if (isPositionEvent) {
        this.connectionMessage = reason || 'published to relay'
      } else {
        this.setConnection(this.connectionStatus, reason || 'published to relay')
      }
      if (!isPositionEvent) this.emit(event)
      return { ok: true, event }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      debugWarn('relay', 'publish failed', {
        kind: event.kind,
        id: shortId(event.id),
        elapsedMs: debugDuration(startedAt),
        message,
      })
      if (message.startsWith('auth-required') && this.signer) {
        debugLog('relay', 'publish retrying after auth', { kind: event.kind, id: shortId(event.id) })
        await this.authenticateAndRefetch()
        try {
          const reason = await this.relay!.publish(event)
          debugLog('relay', 'publish retry ok', {
            kind: event.kind,
            id: shortId(event.id),
            elapsedMs: debugDuration(startedAt),
            reason,
          })
          if (isPositionEvent) {
            this.connectionMessage = reason || 'published to relay'
          } else {
            this.setConnection(this.connectionStatus, reason || 'published to relay')
          }
          if (!isPositionEvent) this.emit(event)
          return { ok: true, event }
        } catch (retryError) {
          debugError('relay', 'publish retry failed', {
            kind: event.kind,
            id: shortId(event.id),
            elapsedMs: debugDuration(startedAt),
            message: retryError instanceof Error ? retryError.message : String(retryError),
          })
          this.setConnection(this.connectionStatus, retryError instanceof Error ? retryError.message : String(retryError))
          this.emit()
          return { ok: false, reason: this.connectionMessage }
        }
      }

      this.setConnection(this.connectionStatus, message)
      this.emit()
      return { ok: false, reason: this.connectionMessage }
    }
  }

  private async publishRaw(event: NestrEvent) {
    try {
      return await this.relay!.publish(event)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('auth-required') && this.signer) {
        await this.authenticateAndRefetch()
        return this.relay!.publish(event)
      }

      throw error
    }
  }

  private async publishToRelays(event: NestrEvent, relayUrls: string[]) {
    const unique = Array.from(new Set(relayUrls))
    const current = unique.includes(this.relayUrl)
    const extraRelays = unique.filter((url) => url !== this.relayUrl)

    if (current) await this.publishRaw(event)
    if (extraRelays.length > 0) {
      const signer = this.signer
      await Promise.all(
        this.profilePool.publish(extraRelays, event, {
          maxWait: 4000,
          onauth: signer ? relayAuthSigner(signer) : undefined,
        }),
      )
    }
  }

  private async publishNip29Event(
    pubkey: string,
    kind: number,
    tags: string[][],
    content = '',
    optimistic = true,
    includePrevious = true,
    targetGroupId = this.groupId,
  ) {
    const groupId = targetGroupId.trim()
    if (!groupId) return { ok: false, reason: 'group-required' }
    if (!this.signer || this.signer.pubkey !== pubkey || !this.relay) {
      return { ok: false, reason: 'live-signer-required' }
    }

    let event: NestrEvent
    try {
      event = await this.signer.signEvent({
        kind,
        created_at: now(),
        tags: [
          groupTag(groupId),
          ...(includePrevious ? this.previousTags() : []),
          ...tags,
          ['client', 'nestr'],
        ],
        content: content.trim(),
      })
    } catch (error) {
      this.setConnection(this.connectionStatus, error instanceof Error ? error.message : String(error))
      this.emit()
      return { ok: false, reason: this.connectionMessage }
    }

    return this.publishSigned(event, optimistic)
  }

  private storeEvent(event: NestrEvent) {
    if (isEphemeralKind(event.kind)) return
    const replaceableKey = replaceableEventKey(event)
    if (replaceableKey) {
      Array.from(this.events.values()).forEach((existing) => {
        if (existing.id !== event.id && replaceableEventKey(existing) === replaceableKey) {
          this.events.delete(existing.id)
        }
      })
    }
    this.events.set(event.id, event)
  }

  private receive(event: NestrEvent) {
    if (event.kind === NIP29_KINDS.groupMetadata) {
      const groupId = tagValue(event, 'd')
      const eventRelayUrl = relayUrlFromGroupEvent(event, this.relayUrl)
      const groupMetadata = withRelayTag(event, eventRelayUrl)
      if (groupId) {
        this.savedRelayUrls.add(eventRelayUrl)
        this.relayGroups.set(relayGroupKey(eventRelayUrl, groupId), groupMetadata)
      }
      if (this.hasSelectedGroup && groupId === this.groupId && sameRelayUrl(eventRelayUrl, this.relayUrl)) {
        this.receiveGroupEvent(groupMetadata)
        return
      }
      this.emit(groupMetadata)
      return
    }

    if (this.hasSelectedGroup && isRelayGeneratedGroupStateKind(event.kind) && tagValue(event, 'd') === this.groupId) {
      this.receiveGroupEvent(event)
      return
    }

    if (!this.hasSelectedGroup || tagValue(event, 'h') !== this.groupId) return

    const isPositionEvent = isOfficePositionKind(event.kind)
    if (!isEphemeralKind(event.kind)) this.storeEvent(event)
    if (!isEphemeralKind(event.kind) && event.pubkey !== this.signer?.pubkey) {
      this.timelineRefs.unshift(event.id.slice(0, 8))
      this.timelineRefs.splice(50)
    }
    this.recordActivity(event.pubkey, isPositionEvent ? Date.now() : event.created_at * 1000)
    this.upsertUser(event.pubkey)
    this.queueProfileFetch([event.pubkey, ...profilePubkeysFromReferences(event.content, event.tags)])

    if (isNip29ModerationKind(event.kind)) {
      this.applyModerationEvent(event)
    }

    if (isPositionEvent) {
      try {
        const payload = parsePositionPayload(event.content)
        const eventTime = positionEventTime(event, payload)
        const current = this.positions.get(event.pubkey)
        const shouldApply = shouldApplyPositionUpdate(current, {
          eventTime,
          eventId: event.id,
          isSelf: event.pubkey === this.signer?.pubkey,
        })

        if (!shouldApply) {
          if (current?.eventId && current.eventId === event.id) {
            this.positions.set(event.pubkey, worldPositionFromPayload(event.pubkey, event, payload))
          }
          this.emit(event)
          return
        }

        this.positions.set(event.pubkey, worldPositionFromPayload(event.pubkey, event, payload))
      } catch {
        // Ignore malformed live movement.
      }
    }

    this.emit(event)
  }

  private async receiveDirectMessage(event: NestrEvent) {
    debugLog('dm', 'receiveDirectMessage event', {
      kind: event.kind,
      id: shortId(event.id),
      pubkey: shortId(event.pubkey),
      signer: shortId(this.signer?.pubkey),
      tags: eventTagSummary(event.tags),
    })
    if (!this.signer) return
    const message =
      event.kind === DM_KINDS.legacyDirectMessage
        ? await unwrapNip04DirectMessage(this.signer, event)
        : await unwrapNip17DirectMessage(this.signer, event)
    if (!message) {
      debugWarn('dm', 'receiveDirectMessage unwrap returned empty', {
        kind: event.kind,
        id: shortId(event.id),
      })
      return
    }

    this.directMessages.set(message.id, message)
    debugLog('dm', 'receiveDirectMessage stored', {
      id: shortId(message.id),
      counterparty: shortId(message.counterparty),
      protocol: message.protocol,
      createdAt: message.createdAt,
    })
    this.upsertUser(message.counterparty)
    this.queueProfileFetch([message.counterparty, message.senderPubkey, message.recipientPubkey])
    this.recordActivity(message.senderPubkey, message.createdAt * 1000)
    this.emit(event)
  }

  private applyModerationEvent(event: NestrEvent) {
    if (event.kind === NIP29_KINDS.putUser) {
      const pubkey = targetPubkey(event)
      if (!pubkey) return
      const roles = targetRoles(event)
      this.memberPubkeys.add(pubkey)
      if (roles.length > 0) this.adminRoles.set(pubkey, roles)
      else this.adminRoles.delete(pubkey)
      this.upsertUser(pubkey)
      this.queueProfileFetch([pubkey])
      this.refreshPresenceSubscription()
    }

    if (event.kind === NIP29_KINDS.removeUser) {
      const pubkey = targetPubkey(event)
      if (!pubkey) return
      this.memberPubkeys.delete(pubkey)
      this.adminRoles.delete(pubkey)
      this.positions.delete(pubkey)
      this.users.delete(pubkey)
      this.refreshPresenceSubscription()
    }

    if (event.kind === NIP29_KINDS.editMetadata) {
      const draft = groupMetadataDraft({ tags: event.tags })
      const preserved = this.group.metadata.tags.filter((tag) => tag[0]?.startsWith('office'))
      this.group = {
        ...this.group,
        metadata: placeholderEvent(
          NIP29_KINDS.groupMetadata,
          this.group.metadata.pubkey,
          [...metadataTags(this.groupId, draft, 'd'), ...preserved],
          this.group.metadata.content,
        ),
      }
    }

    if (event.kind === NIP29_KINDS.deleteEvent) {
      const eventId = targetEventId(event)
      if (eventId) this.deletedEventIds.add(eventId)
    }
  }

  private receiveGroupEvent(event: NestrEvent) {
    if (event.kind === 39000) {
      const groupMetadata = withFallbackName(withRelayTag(event, this.relayUrl), tagValue(this.group.metadata, 'name'))
      this.group = { ...this.group, metadata: groupMetadata }
      this.relayGroups.set(relayGroupKey(this.relayUrl, this.groupId), groupMetadata)
    }
    if (event.kind === 39001) {
      this.group = { ...this.group, admins: event }
      this.adminRoles.clear()
      event.tags
        .filter((tag) => tag[0] === 'p' && tag[1])
        .forEach((tag) => {
          this.adminRoles.set(tag[1], tag.slice(2).filter(Boolean))
          this.upsertUser(tag[1])
        })
      this.refreshPresenceSubscription()
    }
    if (event.kind === 39002) {
      this.group = { ...this.group, members: event }
      this.memberPubkeys.clear()
      event.tags
        .filter((tag) => tag[0] === 'p' && tag[1])
        .forEach((tag) => {
          this.memberPubkeys.add(tag[1])
          this.upsertUser(tag[1])
        })
      this.refreshPresenceSubscription()
    }
    if (event.kind === 39003) this.group = { ...this.group, roles: event }
    if (event.kind === NIP29_KINDS.groupAdmins || event.kind === NIP29_KINDS.groupMembers) {
      this.queueProfileFetch(event.tags.filter((tag) => tag[0] === 'p' && tag[1]).map((tag) => tag[1]))
    }
    this.emit(event)
  }

  private receiveProfile(event: NestrEvent, shouldEmit = true) {
    const previous = this.profiles.get(event.pubkey)
    if (previous && previous.created_at > event.created_at) return false
    if (previous?.id === event.id) return false

    this.profiles.set(event.pubkey, event)
    cacheProfileMetadata(event)
    this.upsertUser(event.pubkey)
    if (shouldEmit) this.emit()
    return true
  }

  private upsertUser(pubkey: string) {
    const existing = this.users.get(pubkey) ?? userFromPubkey(pubkey, this.roleLabel(pubkey))
    const profile = this.profiles.get(pubkey)
    const profileName = profileNameFromContent(profile?.content ?? '') ?? existing.name
    const pictureCandidates = buildProfilePictureCandidates(
      profilePictureFromContent(profile?.content ?? ''),
      pubkey,
      this.blossomServers.get(pubkey) ?? [],
    )
    this.users.set(pubkey, {
      ...existing,
      name: profileName,
      role: this.roleLabel(pubkey),
      pictureUrl: pictureCandidates[0],
      pictureCandidates,
      blossomServers: this.blossomServers.get(pubkey) ?? [],
      dmRelays: this.dmRelays.get(pubkey) ?? [],
      readRelays: this.readRelays.get(pubkey) ?? [],
      writeRelays: this.writeRelays.get(pubkey) ?? [],
    })
  }

  private roleLabel(pubkey: string) {
    return roleLabelFromState(
      this.adminRoles.get(pubkey) ?? [],
      this.memberPubkeys.has(pubkey),
      this.signer?.pubkey === pubkey,
    )
  }

  private queueProfileFetch(pubkeys: string[]) {
    const candidates = Array.from(new Set(pubkeys.filter((pubkey) => /^[0-9a-f]{64}$/i.test(pubkey))))
    let changed = false
    getCachedProfileMetadatas(candidates.filter((pubkey) => !this.profiles.has(pubkey))).forEach((event) => {
      changed = this.receiveProfile(event, false) || changed
    })
    if (changed) this.emit()
    const missing = candidates.filter((pubkey) => !this.profiles.has(pubkey))
    if (missing.length === 0) return

    missing.forEach((pubkey) => this.profileQueue.add(pubkey))
    if (this.profileFetchTimer) return

    this.profileFetchTimer = setTimeout(() => {
      this.profileFetchTimer = undefined
      void this.fetchQueuedProfiles()
    }, 120)
  }

  private async fetchDmRelays(pubkey: string) {
    const cached = this.dmRelays.get(pubkey)
    if (cached) return cached

    try {
      const events = await this.queryRelays(
        [this.relayUrl, ...PROFILE_RELAYS],
        { kinds: [10050], authors: [pubkey], limit: 8 },
        3000,
      )
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
      if (!newest) return []
      this.receiveDmRelays(newest)
      return this.dmRelays.get(pubkey) ?? []
    } catch {
      return []
    }
  }

  private async fetchLegacyDmReadRelays(pubkey: string) {
    const cached = this.readRelays.get(pubkey)
    if (cached) return cached

    try {
      const events = await this.queryRelays(
        [this.relayUrl, ...PROFILE_RELAYS],
        { kinds: [NIP65_RELAY_LIST_KIND], authors: [pubkey], limit: 8 },
        3000,
      )
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
      if (!newest) return []
      this.receiveRelayList(newest)
      return this.readRelays.get(pubkey) ?? []
    } catch {
      return []
    }
  }

  private async fetchSavedSimpleGroups(pubkey: string) {
    const signer = this.signer
    const relayHints = new Set([this.relayUrl, ...PROFILE_RELAYS])
    const readRelays = await this.fetchLegacyDmReadRelays(pubkey)
    readRelays.forEach((relayUrl) => relayHints.add(relayUrl))
    if (this.signer !== signer) return

    try {
      const events = await this.queryRelays(
        Array.from(relayHints),
        { kinds: [NIP51_KINDS.simpleGroups], authors: [pubkey], limit: 8 },
        3200,
      )
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0]
      if (!newest) return
      const previous = this.simpleGroupListEvents.get(pubkey)
      if (previous && previous.created_at > newest.created_at) return

      const parsed = parseSimpleGroupsEvent(newest)
      if (!parsed) return

      this.simpleGroupListEvents.set(pubkey, newest)
      parsed.relays.forEach((relayUrl) => this.savedRelayUrls.add(relayUrl))
      parsed.groups.slice(0, 80).forEach((group) => {
        this.savedRelayUrls.add(group.relayUrl)
        this.relayGroups.set(relayGroupKey(group.relayUrl, group.groupId), this.savedGroupPlaceholder(group, newest))
      })
      this.emit(newest)
      await this.fetchSavedGroupState(parsed.groups.slice(0, 80))
    } catch {
      // Saved group lists are best-effort. The active relay directory still comes from kind 39000.
    }
  }

  private savedGroupPlaceholder(group: SimpleGroupPointer, source: NestrEvent) {
    return placeholderEvent(NIP29_KINDS.groupMetadata, source.pubkey, [
      ['d', group.groupId],
      ['relay', group.relayUrl],
      ['name', group.name ?? group.groupId],
      ['about', `Saved group on ${group.relayUrl}`],
      ['source', String(NIP51_KINDS.simpleGroups)],
    ])
  }

  private async fetchSavedGroupState(groups: SimpleGroupPointer[]) {
    const byRelay = new Map<string, string[]>()
    groups.forEach((group) => {
      const relayUrl = normalizeRelayUrl(group.relayUrl)
      const existing = byRelay.get(relayUrl) ?? []
      if (!existing.includes(group.groupId)) existing.push(group.groupId)
      byRelay.set(relayUrl, existing)
    })

    await Promise.allSettled(
      Array.from(byRelay.entries()).map(async ([relayUrl, groupIds]) => {
        if (groupIds.length === 0) return
        const events = await this.queryRelays(
          [relayUrl],
          {
            kinds: [
              NIP29_KINDS.groupMetadata,
              NIP29_KINDS.groupAdmins,
              NIP29_KINDS.groupMembers,
              NIP29_KINDS.groupRoles,
            ],
            '#d': groupIds,
            limit: Math.max(16, groupIds.length * 4),
          },
          2600,
        )

        events.forEach((event) => this.receiveFetchedGroupState(event, relayUrl))
      }),
    )
    this.emit()
  }

  private receiveFetchedGroupState(event: NestrEvent, relayUrl: string) {
    const groupId = tagValue(event, 'd')
    if (!groupId) return

    const normalizedRelayUrl = normalizeRelayUrl(relayUrl)
    const eventWithRelay = withRelayTag(event, normalizedRelayUrl)
    this.savedRelayUrls.add(normalizedRelayUrl)

    if (event.kind === NIP29_KINDS.groupMetadata) {
      this.relayGroups.set(relayGroupKey(normalizedRelayUrl, groupId), eventWithRelay)
    }

    if (this.hasSelectedGroup && groupId === this.groupId && sameRelayUrl(normalizedRelayUrl, this.relayUrl)) {
      this.receiveGroupEvent(eventWithRelay)
    }
  }

  private async fetchQueuedProfiles() {
    if (this.closed) return
    const authors = Array.from(this.profileQueue).slice(0, PROFILE_FETCH_BATCH_SIZE)
    authors.forEach((pubkey) => this.profileQueue.delete(pubkey))
    if (authors.length === 0) return

    try {
      const events = await this.queryRelays(
        [this.relayUrl, ...PROFILE_RELAYS],
        { kinds: [0, 10050, 10063, NIP65_RELAY_LIST_KIND], authors, limit: authors.length * 4 },
        2600,
      )
      await yieldToMainThread()
      if (this.closed) return
      let changed = false
      events.forEach((event) => {
        if (event.kind === 0) changed = this.receiveProfile(event, false) || changed
        if (event.kind === 10050) changed = this.receiveDmRelays(event, false) || changed
        if (event.kind === NIP65_RELAY_LIST_KIND) changed = this.receiveRelayList(event, false) || changed
        if (event.kind === 10063) changed = this.receiveBlossomServers(event, false) || changed
      })
      if (changed) this.emit()
    } catch {
      // Profile details are best-effort; membership still comes from the group relay.
    }

    if (this.profileQueue.size > 0) {
      this.profileFetchTimer = setTimeout(() => {
        if (this.closed) return
        this.profileFetchTimer = undefined
        void this.fetchQueuedProfiles()
      }, PROFILE_FETCH_BATCH_DELAY_MS)
    }
  }

  private receiveBlossomServers(event: NestrEvent, shouldEmit = true) {
    this.blossomServers.set(event.pubkey, blossomServersFromTags(event.tags))
    this.upsertUser(event.pubkey)
    if (shouldEmit) this.emit()
    return true
  }

  private receiveDmRelays(event: NestrEvent, shouldEmit = true) {
    const previous = this.dmRelayEvents.get(event.pubkey)
    if (previous && previous.created_at > event.created_at) return false
    if (previous?.id === event.id) return false

    this.dmRelayEvents.set(event.pubkey, event)
    this.dmRelays.set(event.pubkey, relaysFromTags(event.tags))
    this.upsertUser(event.pubkey)
    if (event.pubkey === this.signer?.pubkey) {
      setTimeout(() => {
        if (!this.closed && event.pubkey === this.signer?.pubkey) void this.openDmRelaySubscriptions()
      }, 0)
    }
    if (shouldEmit) this.emit()
    return true
  }

  private receiveRelayList(event: NestrEvent, shouldEmit = true) {
    const previous = this.relayListEvents.get(event.pubkey)
    if (previous && previous.created_at > event.created_at) return false
    if (previous?.id === event.id) return false

    const relays = readWriteRelaysFromTags(event.tags)
    this.relayListEvents.set(event.pubkey, event)
    this.readRelays.set(event.pubkey, relays.read)
    this.writeRelays.set(event.pubkey, relays.write)
    this.upsertUser(event.pubkey)
    if (event.pubkey === this.signer?.pubkey) {
      setTimeout(() => {
        if (!this.closed && event.pubkey === this.signer?.pubkey) void this.openDmRelaySubscriptions()
      }, 0)
    }
    if (shouldEmit) this.emit()
    return true
  }

  private previousTags() {
    return this.timelineRefs.slice(0, 3).map((id) => ['previous', id])
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

export function createLiveRelay(groupId: string | undefined, relayUrl: string, groupNameHint = '') {
  return new LiveNip29Relay(groupId, relayUrl, groupNameHint)
}
