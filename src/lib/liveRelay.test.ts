import { describe, expect, it, vi } from 'vitest'
import {
  blossomServersFromTags,
  buildProfilePictureCandidates,
  extractBlossomPointer,
  profileNameFromContent,
  profilePictureFromContent,
} from './profileImages'
import { LiveNip29Relay, directMessageSubscriptionFilters, roleLabelFromState } from './liveRelay'
import type { NestrEvent, NestrEventTemplate } from './nostr'
import { POSITION_REBROADCAST_RESIGN_AFTER_MS } from './positionEvents'

describe('live NIP-29 helpers', () => {
  it('uses profile display names when profile metadata is available', () => {
    expect(profileNameFromContent(JSON.stringify({ display_name: 'Ben Arc', name: 'ben' }))).toBe(
      'Ben Arc',
    )
    expect(profileNameFromContent('{')).toBeNull()
  })

  it('extracts profile picture URLs from kind 0 metadata', () => {
    expect(profilePictureFromContent(JSON.stringify({ picture: 'https://example.com/me.png' }))).toBe(
      'https://example.com/me.png',
    )
    expect(profilePictureFromContent('{}')).toBeNull()
  })

  it('builds Blossom picture candidates from Blossom URIs and server lists', () => {
    const hash = 'a'.repeat(64)
    const pointer = extractBlossomPointer(`blossom:${hash}.jpg?xs=https%3A%2F%2Fmedia.example`, 'b'.repeat(64))

    expect(pointer?.hash).toBe(hash)
    expect(blossomServersFromTags([['server', 'https://cdn.example/']])).toEqual(['https://cdn.example'])
    expect(
      buildProfilePictureCandidates(`blossom:${hash}.jpg`, 'b'.repeat(64), ['https://cdn.example/']),
    ).toContain(`https://cdn.example/${hash}.jpg`)
  })

  it('labels NIP-29 roles from relay state clearly', () => {
    expect(roleLabelFromState(['bishop'], true)).toBe('admin: bishop')
    expect(roleLabelFromState([], true)).toBe('member')
    expect(roleLabelFromState([], false, true)).toBe('signed in')
    expect(roleLabelFromState([], false)).toBe('participant')
  })

  it('subscribes to NIP-17 wraps and legacy NIP-04 direct messages', () => {
    const pubkey = 'a'.repeat(64)

    expect(directMessageSubscriptionFilters(pubkey)).toEqual([
      { kinds: [1059], '#p': [pubkey], limit: 120 },
      { kinds: [4], '#p': [pubkey], limit: 120 },
      { kinds: [4], authors: [pubkey], limit: 120 },
    ])
  })

  it('refreshes inbox subscriptions for the current signer', async () => {
    const pubkey = 'b'.repeat(64)
    const staleRoomClose = vi.fn()
    const staleRelayClose = vi.fn()
    const freshRoomClose = vi.fn()
    const roomSubscribe = vi.fn(() => ({ close: freshRoomClose }))
    const querySync = vi.fn(async () => [])

    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      refreshDirectMessageSubscriptions: () => void
      dmRelaySubs: Array<{ close: () => void }>
    }
    relay.relayUrl = 'wss://relay.example'
    relay.signer = {
      pubkey,
      label: 'test',
      signEvent: vi.fn(),
    }
    relay.relay = { subscribe: roomSubscribe }
    relay.profilePool = { querySync, subscribe: vi.fn() }
    relay.dmSub = { close: staleRoomClose }
    relay.dmRelaySubs = [{ close: staleRelayClose }]
    relay.dmRelays = new Map()
    relay.readRelays = new Map()

    relay.refreshDirectMessageSubscriptions()
    await Promise.resolve()

    expect(staleRoomClose).toHaveBeenCalledOnce()
    expect(staleRelayClose).toHaveBeenCalledOnce()
    expect(roomSubscribe).toHaveBeenCalledWith(
      directMessageSubscriptionFilters(pubkey),
      expect.objectContaining({ eoseTimeout: 3500 }),
    )
    expect(relay.dmRelaySubs).toEqual([])
  })

  it('does not request the whole relay directory while opening a selected group', () => {
    const subscribe = vi.fn((filtersArg: unknown, optionsArg: unknown) => {
      void filtersArg
      void optionsArg
      return { close: vi.fn() }
    })
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      openGroupSubscription: () => void
      roomAccessTimer?: ReturnType<typeof setTimeout>
    }
    relay.closed = false
    relay.hasSelectedGroup = true
    relay.groupId = 'room'
    relay.relayUrl = 'wss://relay.example'
    relay.roomAccessStatus = 'unknown'
    relay.groupSub = undefined
    relay.relay = { subscribe }
    relay.emit = vi.fn()
    relay.receive = vi.fn()

    relay.openGroupSubscription()

    expect(subscribe).toHaveBeenCalledOnce()
    const filters = subscribe.mock.calls[0]?.[0] as unknown[]
    expect(filters).toContainEqual({ kinds: [39000, 39001, 39002, 39003], '#d': ['room'], limit: 32 })
    expect(filters).not.toContainEqual({ kinds: [39000], limit: 240 })
    if (relay.roomAccessTimer) clearTimeout(relay.roomAccessTimer)
  })

  it('skips the active room relay for generic author helper queries', async () => {
    const roomSubscribe = vi.fn(() => ({ close: vi.fn() }))
    const profileQuery = vi.fn(async () => [])
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      queryRelays: (relays: string[], filter: unknown, maxWait: number) => Promise<NestrEvent[]>
    }
    relay.closed = false
    relay.relayUrl = 'wss://groups.0xchat.com'
    relay.relay = { subscribe: roomSubscribe }
    relay.profilePool = { querySync: profileQuery }

    await relay.queryRelays(
      ['wss://groups.0xchat.com', 'wss://purplepag.es'],
      { kinds: [0], authors: ['a'.repeat(64)], limit: 1 },
      50,
    )

    expect(roomSubscribe).not.toHaveBeenCalled()
    expect(profileQuery).toHaveBeenCalledWith(
      ['wss://purplepag.es'],
      { kinds: [0], authors: ['a'.repeat(64)], limit: 1 },
      { maxWait: 50 },
    )
  })

  it('uses the existing room socket for group-state helper queries on the active relay', async () => {
    const roomClose = vi.fn()
    const roomSubscribe = vi.fn((filtersArg: unknown, optionsArg: { oneose?: () => void }) => {
      void filtersArg
      setTimeout(() => optionsArg.oneose?.(), 0)
      return { close: roomClose }
    })
    const profileQuery = vi.fn(async () => [])
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      queryRelays: (relays: string[], filter: unknown, maxWait: number) => Promise<NestrEvent[]>
    }
    relay.closed = false
    relay.relayUrl = 'wss://groups.0xchat.com'
    relay.relay = { subscribe: roomSubscribe }
    relay.profilePool = { querySync: profileQuery }

    await relay.queryRelays(
      ['wss://groups.0xchat.com', 'wss://purplepag.es'],
      { kinds: [39000, 39001, 39002, 39003], '#d': ['room'], limit: 4 },
      50,
    )

    expect(roomSubscribe).toHaveBeenCalledOnce()
    expect(profileQuery).toHaveBeenCalledWith(
      ['wss://purplepag.es'],
      { kinds: [39000, 39001, 39002, 39003], '#d': ['room'], limit: 4 },
      { maxWait: 50 },
    )
    expect(roomClose).toHaveBeenCalledOnce()
  })

  it('discards stale in-flight position signatures when newer movement is queued', async () => {
    const pubkey = 'c'.repeat(64)
    const publish = vi.fn<(event: NestrEvent) => Promise<string>>()
    publish.mockResolvedValue('ok')
    const resolvers: Array<(event: NestrEvent) => void> = []
    const signEvent = vi.fn(
      (template: NestrEventTemplate) =>
        new Promise<NestrEvent>((resolve) => {
          resolvers.push((event) => resolve({ ...event, ...template }))
        }),
    )

    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      publishPosition: LiveNip29Relay['publishPosition']
    }
    relay.hasSelectedGroup = true
    relay.groupId = 'room'
    relay.relayUrl = 'wss://relay.example'
    relay.group = { metadata: { tags: [] } }
    relay.signer = { pubkey, label: 'test', signEvent }
    relay.relay = { publish }
    relay.memberPubkeys = new Set([pubkey])
    relay.adminRoles = new Map()
    relay.positions = new Map()
    relay.positionPublishVersion = 0
    relay.positionPublishInFlight = false
    relay.pendingPositionPublish = undefined
    relay.connectionStatus = 'connected'
    relay.connectionMessage = 'connected'
    relay.emit = vi.fn()

    const first = relay.publishPosition(pubkey, { startX: 0, startY: 0, endX: 100, endY: 0, speed: 100 }, 1000)
    const second = relay.publishPosition(pubkey, { startX: 0, startY: 0, endX: 200, endY: 0, speed: 100 }, 1100)

    await expect(second).resolves.toMatchObject({ ok: false, reason: 'position-publish-queued' })
    expect(signEvent).toHaveBeenCalledTimes(1)
    expect(signEvent.mock.calls[0]?.[0]).toMatchObject({
      kind: 25029,
      tags: expect.arrayContaining([
        ['h', 'room'],
        ['relay', 'wss://relay.example'],
        ['client', 'nestr'],
      ]),
    })
    expect(signEvent.mock.calls[0]?.[0].tags).not.toContainEqual(['d', 'room'])

    resolvers[0]({
      id: 'first',
      sig: 'sig',
      pubkey,
      kind: 25029,
      created_at: 1,
      tags: [],
      content: '',
    })
    await expect(first).resolves.toMatchObject({ ok: false, reason: 'stale-position-discarded' })
    expect(publish).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(signEvent).toHaveBeenCalledTimes(2))
    resolvers[1]({
      id: 'second',
      sig: 'sig',
      pubkey,
      kind: 25029,
      created_at: 1,
      tags: [],
      content: '',
    })
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ id: 'second' })
  })

  it('republishes the last signed position event without signing again', async () => {
    const pubkey = 'd'.repeat(64)
    const publish = vi.fn<(event: NestrEvent) => Promise<string>>()
    publish.mockResolvedValue('ok')
    const signEvent = vi.fn(async (template: NestrEventTemplate) => ({
      ...template,
      id: 'signed-position',
      sig: 'sig',
      pubkey,
    }))

    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      publishPosition: LiveNip29Relay['publishPosition']
      republishLastPosition: LiveNip29Relay['republishLastPosition']
    }
    relay.hasSelectedGroup = true
    relay.groupId = 'room'
    relay.relayUrl = 'wss://relay.example'
    relay.group = { metadata: { tags: [] } }
    relay.signer = { pubkey, label: 'test', signEvent }
    relay.relay = { publish }
    relay.memberPubkeys = new Set([pubkey])
    relay.adminRoles = new Map()
    relay.positions = new Map()
    relay.activityAt = new Map()
    relay.positionPublishVersion = 0
    relay.positionPublishInFlight = false
    relay.pendingPositionPublish = undefined
    relay.connectionStatus = 'connected'
    relay.connectionMessage = 'connected'
    relay.emit = vi.fn()

    await expect(
      relay.publishPosition(pubkey, { startX: 0, startY: 0, endX: 10, endY: 0, speed: 100 }, 1000),
    ).resolves.toMatchObject({ ok: true })
    await expect(relay.republishLastPosition(pubkey)).resolves.toMatchObject({ ok: true })

    expect(signEvent).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.calls[0]?.[0]).toBe(publish.mock.calls[1]?.[0])
  })

  it('requests a fresh position signature after the rebroadcast window', async () => {
    const pubkey = 'e'.repeat(64)
    const publish = vi.fn<(event: NestrEvent) => Promise<string>>()
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      republishLastPosition: LiveNip29Relay['republishLastPosition']
    }
    relay.hasSelectedGroup = true
    relay.signer = {
      pubkey,
      label: 'test',
      signEvent: vi.fn(),
    }
    relay.relay = { publish }
    relay.positionPublishInFlight = false
    relay.pendingPositionPublish = undefined
    relay.lastSignedPositionEvent = {
      id: 'old-position',
      sig: 'sig',
      pubkey,
      kind: 25029,
      tags: [['h', 'room']],
      content: '{}',
      created_at: Math.floor((Date.now() - POSITION_REBROADCAST_RESIGN_AFTER_MS - 1000) / 1000),
    }

    await expect(relay.republishLastPosition(pubkey)).resolves.toMatchObject({
      ok: false,
      reason: 'position-refresh-needs-signature',
    })
    expect(publish).not.toHaveBeenCalled()
  })

  it('requests a fresh position signature when the relay rejects the cached event as too old', async () => {
    const pubkey = 'f'.repeat(64)
    const publish = vi.fn<(event: NestrEvent) => Promise<string>>(async () => {
      throw new Error('blocked: event too old')
    })
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      republishLastPosition: LiveNip29Relay['republishLastPosition']
      connectionStatus: string
      connectionMessage: string
    }
    relay.hasSelectedGroup = true
    relay.signer = {
      pubkey,
      label: 'test',
      signEvent: vi.fn(),
    }
    relay.relay = { publish }
    relay.positionPublishInFlight = false
    relay.pendingPositionPublish = undefined
    relay.connectionStatus = 'connected'
    relay.connectionMessage = 'connected'
    relay.setConnection = vi.fn((status: string, message: string) => {
      relay.connectionStatus = status
      relay.connectionMessage = message
    })
    relay.emit = vi.fn()
    relay.lastSignedPositionEvent = {
      id: 'fresh-but-rejected-position',
      sig: 'sig',
      pubkey,
      kind: 25029,
      tags: [['h', 'room']],
      content: '{}',
      created_at: Math.floor(Date.now() / 1000),
    }

    await expect(relay.republishLastPosition(pubkey)).resolves.toMatchObject({
      ok: false,
      reason: 'position-refresh-needs-signature',
    })
    expect(publish).toHaveBeenCalledOnce()
    expect(relay.lastSignedPositionEvent).toBeUndefined()
  })
})
