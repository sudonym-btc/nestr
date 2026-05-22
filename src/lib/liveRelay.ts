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
  OFFICE_KINDS,
  groupTag,
  tagValue,
  type NestrEvent,
  type NestrSigner,
} from './nostr'
import type { MockUser, Nip29Group, RelaySnapshot } from './mockRelay'
import {
  blossomServersFromTags,
  buildProfilePictureCandidates,
  profileNameFromContent,
  profilePictureFromContent,
} from './profileImages'
import type { WorldPosition } from './world'

const encoder = new TextEncoder()
const GROUP_CHAT_KINDS = new Set([1, 9])
const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.nostr.band', 'wss://relay.damus.io']

function now() {
  return Math.floor(Date.now() / 1000)
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

function userFromPubkey(pubkey: string, role = 'member'): MockUser {
  return {
    pubkey,
    npub: npubForPubkey(pubkey),
    name: shortNpub(pubkey),
    role,
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

export class LiveNip29Relay {
  readonly mode = 'live' as const
  readonly relayUrl: string
  readonly groupId: string

  private readonly listeners = new Set<(snapshot: RelaySnapshot, event?: NestrEvent) => void>()
  private readonly profilePool = new SimplePool({ enableReconnect: true })
  private readonly events = new Map<string, NestrEvent>()
  private readonly positions = new Map<string, WorldPosition>()
  private readonly users = new Map<string, MockUser>()
  private readonly profiles = new Map<string, NestrEvent>()
  private readonly blossomServers = new Map<string, string[]>()
  private readonly memberPubkeys = new Set<string>()
  private readonly adminRoles = new Map<string, string[]>()
  private readonly profileQueue = new Set<string>()
  private readonly timelineRefs: string[] = []
  private relay?: Relay
  private groupSub?: ReturnType<Relay['subscribe']>
  private profileFetchTimer?: ReturnType<typeof setTimeout>
  private group: Nip29Group
  private signer?: NestrSigner
  private connectionStatus: RelaySnapshot['connectionStatus'] = 'connecting'
  private connectionMessage = 'connecting to live relay'
  private lastPositionPublish = 0

  constructor(groupId: string, relayUrl: string) {
    this.groupId = groupId
    this.relayUrl = relayUrl
    const relayPubkey = placeholderPubkey(`relay:${relayUrl}`)
    this.group = {
      id: groupId,
      relay: relayUrl,
      metadata: placeholderEvent(39000, relayPubkey, [
        ['d', groupId],
        ['name', 'Live NIP-29 Office'],
        ['about', `${groupId} on ${relayUrl}`],
        ['restricted'],
        ['office', '1'],
      ]),
      admins: placeholderEvent(39001, relayPubkey, [['d', groupId]], 'relay admins pending'),
      members: placeholderEvent(39002, relayPubkey, [['d', groupId]], 'relay members pending'),
      roles: placeholderEvent(39003, relayPubkey, [['d', groupId]], 'relay roles pending'),
    }
    void this.connect()
  }

  snapshot(): RelaySnapshot {
    const messages = Array.from(this.events.values())
      .filter((event) => GROUP_CHAT_KINDS.has(event.kind))
      .sort((a, b) => a.created_at - b.created_at)

    return {
      mode: this.mode,
      connectionStatus: this.connectionStatus,
      connectionMessage: this.connectionMessage,
      group: this.group,
      users: Array.from(this.users.values()),
      messages,
      positions: Array.from(this.positions.values()),
      eventCount: this.events.size,
    }
  }

  subscribe(listener: (snapshot: RelaySnapshot, event?: NestrEvent) => void) {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  async setSigner(signer: NestrSigner) {
    this.signer = signer
    this.upsertUser(signer.pubkey)
    this.connectionMessage = `${signer.label} connected`
    this.emit()
    await this.authenticateAndRefetch()
  }

  joinWithNpub(value: string) {
    const pubkey = placeholderPubkey(`watch:${value}`)
    const user = userFromPubkey(pubkey, 'watching')
    this.users.set(pubkey, user)
    this.emit()
    return user
  }

  async publishGroupMessage(pubkey: string, content: string) {
    const trimmed = content.trim()
    if (!trimmed || !this.signer || this.signer.pubkey !== pubkey || !this.relay) {
      return { ok: false, reason: 'live-signer-required' }
    }

    const event = await this.signer.signEvent({
      kind: 9,
      created_at: now(),
      tags: [groupTag(this.groupId), ...this.previousTags(), ['client', 'nestr']],
      content: trimmed,
    })

    return this.publishSigned(event)
  }

  async publishPosition(
    pubkey: string,
    x: number,
    y: number,
    vx: number,
    vy: number,
    createdAt = Date.now(),
  ) {
    if (!this.signer || this.signer.pubkey !== pubkey || !this.relay) {
      return { ok: false, reason: 'live-signer-required' }
    }

    if (createdAt - this.lastPositionPublish < 320) {
      return { ok: false, reason: 'throttled' }
    }
    this.lastPositionPublish = createdAt

    const facing = Math.abs(vx) > Math.abs(vy) ? (vx >= 0 ? 'east' : 'west') : vy < 0 ? 'north' : 'south'
    const event = await this.signer.signEvent({
      kind: OFFICE_KINDS.avatarPosition,
      created_at: Math.floor(createdAt / 1000),
      tags: [groupTag(this.groupId), ['relay', this.relayUrl]],
      content: JSON.stringify({ x, y, vx, vy, facing }),
    })

    return this.publishSigned(event)
  }

  tickBots() {
    // Live relays supply movement; the client does not fabricate people in live mode.
  }

  close() {
    this.groupSub?.close()
    if (this.profileFetchTimer) clearTimeout(this.profileFetchTimer)
    this.profilePool.destroy()
    this.relay?.close()
  }

  private async connect() {
    try {
      const relay = await Relay.connect(this.relayUrl, { enableReconnect: true })
      this.relay = relay
      this.connectionStatus = 'connected'
      this.connectionMessage = 'live relay connected'
      relay.onauth = async (event: EventTemplate) => {
        if (!this.signer) throw new Error('signer required for relay auth')
        return relayAuthSigner(this.signer)(event)
      }

      this.openGroupSubscription()
      if (this.signer) void this.authenticateAndRefetch()
      this.emit()
    } catch (error) {
      this.connectionStatus = 'error'
      this.connectionMessage = error instanceof Error ? error.message : String(error)
      this.emit()
    }
  }

  private openGroupSubscription() {
    if (!this.relay) return

    this.groupSub?.close()
    const filters: Filter[] = [
      { kinds: [39000, 39001, 39002, 39003], '#d': [this.groupId], limit: 32 },
      { '#h': [this.groupId], limit: 180 },
    ]

    this.groupSub = this.relay.subscribe(filters, {
      onevent: (event) => this.receive(event as NestrEvent),
      onclose: (reason) => {
        if (reason?.startsWith('auth-required') && this.signer) {
          this.connectionMessage = 'relay requested NIP-42 auth'
          this.emit()
          void this.authenticateAndRefetch()
          return
        }

        this.connectionStatus = 'disconnected'
        this.connectionMessage = reason || 'relay subscription closed'
        this.emit()
      },
      oneose: () => this.emit(),
      eoseTimeout: 3500,
    })
  }

  private async authenticateAndRefetch() {
    if (!this.relay || !this.signer) return

    try {
      await this.relay.auth(relayAuthSigner(this.signer))
      this.connectionStatus = 'authenticated'
      this.connectionMessage = `NIP-42 authenticated as ${shortNpub(this.signer.pubkey)}`
      this.openGroupSubscription()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('no challenge')) {
        this.connectionStatus = 'connected'
        this.connectionMessage = 'signer connected; relay has not sent a NIP-42 challenge'
      } else {
        this.connectionStatus = 'connected'
        this.connectionMessage = `NIP-42 auth failed: ${message}`
      }
    }

    this.emit()
  }

  private async publishSigned(event: NestrEvent) {
    this.receive(event)
    try {
      const reason = await this.relay!.publish(event)
      this.connectionMessage = reason || 'published to relay'
      this.emit(event)
      return { ok: true, event }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('auth-required') && this.signer) {
        await this.authenticateAndRefetch()
        try {
          const reason = await this.relay!.publish(event)
          this.connectionMessage = reason || 'published to relay'
          this.emit(event)
          return { ok: true, event }
        } catch (retryError) {
          this.connectionMessage = retryError instanceof Error ? retryError.message : String(retryError)
          this.emit()
          return { ok: false, reason: this.connectionMessage }
        }
      }

      this.connectionMessage = message
      this.emit()
      return { ok: false, reason: this.connectionMessage }
    }
  }

  private receive(event: NestrEvent) {
    if (tagValue(event, 'd') === this.groupId) {
      this.receiveGroupEvent(event)
    }

    if (tagValue(event, 'h') !== this.groupId) return

    this.events.set(event.id, event)
    if (event.pubkey !== this.signer?.pubkey) {
      this.timelineRefs.unshift(event.id.slice(0, 8))
      this.timelineRefs.splice(50)
    }
    this.upsertUser(event.pubkey)
    this.queueProfileFetch([event.pubkey])

    if (event.kind === OFFICE_KINDS.avatarPosition) {
      try {
        const payload = JSON.parse(event.content) as Omit<WorldPosition, 'pubkey' | 'updatedAt'>
        this.positions.set(event.pubkey, {
          pubkey: event.pubkey,
          x: payload.x,
          y: payload.y,
          vx: payload.vx,
          vy: payload.vy,
          facing: payload.facing,
          updatedAt: Date.now(),
        })
      } catch {
        // Ignore malformed live movement.
      }
    }

    this.emit(event)
  }

  private receiveGroupEvent(event: NestrEvent) {
    if (event.kind === 39000) this.group = { ...this.group, metadata: event }
    if (event.kind === 39001) {
      this.group = { ...this.group, admins: event }
      this.adminRoles.clear()
      event.tags
        .filter((tag) => tag[0] === 'p' && tag[1])
        .forEach((tag) => {
          this.adminRoles.set(tag[1], tag.slice(2).filter(Boolean))
          this.upsertUser(tag[1])
        })
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
    }
    if (event.kind === 39003) this.group = { ...this.group, roles: event }
    if (event.kind === NIP29_KINDS.groupAdmins || event.kind === NIP29_KINDS.groupMembers) {
      this.queueProfileFetch(event.tags.filter((tag) => tag[0] === 'p' && tag[1]).map((tag) => tag[1]))
    }
    this.emit(event)
  }

  private receiveProfile(event: NestrEvent) {
    const previous = this.profiles.get(event.pubkey)
    if (previous && previous.created_at > event.created_at) return

    this.profiles.set(event.pubkey, event)
    this.upsertUser(event.pubkey)
    this.emit()
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
      name: this.signer?.pubkey === pubkey ? 'You' : profileName,
      role: this.roleLabel(pubkey),
      pictureUrl: pictureCandidates[0],
      pictureCandidates,
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
    const missing = pubkeys.filter(
      (pubkey) => /^[0-9a-f]{64}$/i.test(pubkey) && !this.profiles.has(pubkey),
    )
    if (missing.length === 0) return

    missing.forEach((pubkey) => this.profileQueue.add(pubkey))
    if (this.profileFetchTimer) return

    this.profileFetchTimer = setTimeout(() => {
      this.profileFetchTimer = undefined
      void this.fetchQueuedProfiles()
    }, 120)
  }

  private async fetchQueuedProfiles() {
    const authors = Array.from(this.profileQueue).slice(0, 80)
    authors.forEach((pubkey) => this.profileQueue.delete(pubkey))
    if (authors.length === 0) return

    const relays = Array.from(new Set([this.relayUrl, ...PROFILE_RELAYS]))
    try {
      const events = (await this.profilePool.querySync(
        relays,
        { kinds: [0, 10063], authors, limit: authors.length * 2 },
        { maxWait: 2600 },
      )) as NestrEvent[]
      events.forEach((event) => {
        if (event.kind === 0) this.receiveProfile(event)
        if (event.kind === 10063) this.receiveBlossomServers(event)
      })
    } catch {
      // Profile metadata is best-effort; NIP-29 membership still comes from the group relay.
    }

    if (this.profileQueue.size > 0) {
      this.profileFetchTimer = setTimeout(() => {
        this.profileFetchTimer = undefined
        void this.fetchQueuedProfiles()
      }, 240)
    }
  }

  private receiveBlossomServers(event: NestrEvent) {
    this.blossomServers.set(event.pubkey, blossomServersFromTags(event.tags))
    this.upsertUser(event.pubkey)
    this.emit()
  }

  private previousTags() {
    return this.timelineRefs.slice(0, 3).map((id) => ['previous', id])
  }

  private emit(event?: NestrEvent) {
    const snapshot = this.snapshot()
    this.listeners.forEach((listener) => listener(snapshot, event))
  }
}

export function createLiveRelay(groupId: string, relayUrl: string) {
  return new LiveNip29Relay(groupId, relayUrl)
}
