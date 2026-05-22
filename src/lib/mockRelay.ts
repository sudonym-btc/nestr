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
  type NestrEvent,
} from './nostr'
import { npubForPubkey, resolvePubkey, seededSecret, shortNpub } from './avatar'
import {
  buildOfficeMap,
  spawnForPubkey,
  type OfficeMap,
  type WorldPosition,
} from './world'

const encoder = new TextEncoder()

export interface MockUser {
  pubkey: string
  npub: string
  name: string
  role: string
  secretKey?: Uint8Array
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
  group: Nip29Group
  users: MockUser[]
  messages: NestrEvent[]
  positions: WorldPosition[]
  eventCount: number
}

type RelayListener = (snapshot: RelaySnapshot, event?: NestrEvent) => void

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
  readonly relayUrl = MOCK_RELAY_URL
  readonly relayPubkey: string

  private readonly relaySecret = seededSecret('relay')
  private readonly groupId = DEFAULT_GROUP_ID
  private readonly listeners = new Set<RelayListener>()
  private readonly events: NestrEvent[] = []
  private readonly users = new Map<string, MockUser>()
  private readonly positions = new Map<string, WorldPosition>()
  private group: Nip29Group

  constructor() {
    this.relayPubkey = getPublicKey(this.relaySecret)
    this.group = this.createGroup()
    demoUsers.forEach((user, index) => this.addSeedUser(user, index))
    this.seedMessages()
  }

  snapshot(): RelaySnapshot {
    const messages = this.events
      .filter((event) => event.kind === NIP29_KINDS.chatMessage)
      .sort((a, b) => a.created_at - b.created_at)

    return {
      group: this.group,
      users: Array.from(this.users.values()),
      messages,
      positions: Array.from(this.positions.values()),
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

  joinWithNpub(value: string) {
    const pubkey = resolvePubkey(value)
    const existing = this.users.get(pubkey)
    if (existing) return existing

    const user: MockUser = {
      pubkey,
      npub: npubForPubkey(pubkey),
      name: shortNpub(pubkey),
      role: 'guest',
    }

    this.users.set(pubkey, user)
    this.refreshMembersEvent()
    const map = buildOfficeMap(this.groupId, this.users.size)
    const spawn = spawnForPubkey(map, pubkey, this.users.size)
    this.publishPosition(pubkey, spawn.x, spawn.y, 0, 0)
    this.emit()
    return user
  }

  publishGroupMessage(pubkey: string, content: string) {
    const user = this.users.get(pubkey)
    const trimmed = content.trim()
    if (!user || trimmed.length === 0) return { ok: false, reason: 'invalid-message' }

    const template = {
      kind: NIP29_KINDS.chatMessage,
      pubkey,
      created_at: now(),
      tags: [groupTag(this.groupId), ['client', 'nestr']],
      content: trimmed,
    }

    const event = user.secretKey
      ? sign(template, user.secretKey)
      : mockSignature(template)

    return this.publish(event)
  }

  publishPosition(
    pubkey: string,
    x: number,
    y: number,
    vx: number,
    vy: number,
    createdAt = Date.now(),
  ) {
    const user = this.users.get(pubkey)
    if (!user) return { ok: false, reason: 'unknown-user' }

    const facing = Math.abs(vx) > Math.abs(vy) ? (vx >= 0 ? 'east' : 'west') : vy < 0 ? 'north' : 'south'
    const template = {
      kind: OFFICE_KINDS.avatarPosition,
      pubkey,
      created_at: Math.floor(createdAt / 1000),
      tags: [groupTag(this.groupId), ['relay', this.relayUrl]],
      content: JSON.stringify({ x, y, vx, vy, facing }),
    }

    const event = user.secretKey
      ? sign(template, user.secretKey)
      : mockSignature(template)

    return this.publish(event)
  }

  publish(event: NestrEvent) {
    if (tagValue(event, 'h') !== this.groupId && event.kind !== NIP29_KINDS.groupMetadata) {
      return { ok: false, reason: 'missing-nip29-h-tag' }
    }

    if (event.kind === OFFICE_KINDS.avatarPosition) {
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
    }

    if (!isEphemeralKind(event.kind)) {
      this.events.push(event)
    }

    this.emit(event)
    return { ok: true, event }
  }

  tickBots(excludePubkey: string, map: OfficeMap) {
    const timestamp = Date.now()

    Array.from(this.users.values())
      .filter((user) => user.pubkey !== excludePubkey)
      .forEach((user, index) => {
        const current = this.positions.get(user.pubkey) ?? {
          pubkey: user.pubkey,
          ...spawnForPubkey(map, user.pubkey, index),
          vx: 0,
          vy: 0,
          facing: 'south' as const,
          updatedAt: timestamp,
        }
        const driftSeed = Number.parseInt(user.pubkey.slice(index, index + 4), 16)
        const angle = timestamp / (1800 + (driftSeed % 900)) + index
        const vx = Math.cos(angle) * 0.55
        const vy = Math.sin(angle * 0.8) * 0.5
        const x = Math.max(56, Math.min(map.cols * map.tileSize - 56, current.x + vx * 16))
        const y = Math.max(56, Math.min(map.rows * map.tileSize - 56, current.y + vy * 16))

        this.publishPosition(user.pubkey, x, y, vx, vy, timestamp)
      })
  }

  private addSeedUser(user: MockUser, index: number) {
    this.users.set(user.pubkey, user)
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
  }

  private createGroup(): Nip29Group {
    const metadata = sign(
      {
        kind: NIP29_KINDS.groupMetadata,
        pubkey: this.relayPubkey,
        created_at: now(),
        tags: [
          dTag(this.groupId),
          ['name', 'Nestr Design Office'],
          ['about', 'A relay-native spatial room'],
          ['picture', 'https://placehold.co/128x128/f4f1e9/171922?text=N'],
          ['restricted'],
          ['office', '1'],
          ['office-map', 'nostr-office-v1'],
        ],
        content: '',
      },
      this.relaySecret,
    )

    const admins = sign(
      {
        kind: NIP29_KINDS.groupAdmins,
        pubkey: this.relayPubkey,
        created_at: now(),
        tags: [dTag(this.groupId), ['p', demoUsers[0].pubkey, 'admin'], ['p', demoUsers[1].pubkey, 'moderator']],
        content: 'relay-generated admins',
      },
      this.relaySecret,
    )

    const members = sign(
      {
        kind: NIP29_KINDS.groupMembers,
        pubkey: this.relayPubkey,
        created_at: now(),
        tags: [dTag(this.groupId), ...demoUsers.map((user) => ['p', user.pubkey])],
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
          dTag(this.groupId),
          ['role', 'admin', 'metadata, invites, moderation'],
          ['role', 'moderator', 'moderation'],
          ['role', 'builder', 'office map changes'],
        ],
        content: 'relay-supported roles',
      },
      this.relaySecret,
    )

    return { id: this.groupId, relay: this.relayUrl, metadata, admins, members, roles }
  }

  private refreshMembersEvent() {
    this.group = {
      ...this.group,
      members: sign(
        {
          kind: NIP29_KINDS.groupMembers,
          pubkey: this.relayPubkey,
          created_at: now(),
          tags: [dTag(this.groupId), ...Array.from(this.users.values()).map((user) => ['p', user.pubkey])],
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
    })
  }

  private emit(event?: NestrEvent) {
    const snapshot = this.snapshot()
    this.listeners.forEach((listener) => listener(snapshot, event))
  }
}

export function createMockRelay() {
  return new MockNip29Relay()
}
