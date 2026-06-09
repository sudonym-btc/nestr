import { describe, expect, it, vi } from 'vitest'
import {
  blossomServersFromTags,
  buildProfilePictureCandidates,
  extractBlossomPointer,
  profileNameFromContent,
  profilePictureFromContent,
} from './profileImages'
import {
  LiveNip29Relay,
  directMessageSubscriptionFilters,
  legacyDirectMessageReadFilters,
  legacyDirectMessageWriteFilters,
  nip17DirectMessageSubscriptionFilters,
  roleLabelFromState,
} from './liveRelay'
import { NIP29_KINDS, NIP51_KINDS, OFFICE_KINDS, type NestrEvent, type NestrEventTemplate } from './nostr'
import { POSITION_REBROADCAST_RESIGN_AFTER_MS } from './positionEvents'
import { relayGroupKey, relayUrlFromGroupEvent } from './relayDiscovery'

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
    let roomOptions: { oneose?: () => void } | undefined
    const roomSubscribe = vi.fn((filters: unknown, options: { oneose?: () => void }) => {
      const filterList = Array.isArray(filters) ? filters as Array<{ kinds?: number[] }> : []
      if (filterList.some((filter) => filter.kinds?.includes(10002))) {
        options.oneose?.()
        return { close: vi.fn() }
      }
      roomOptions = options
      return { close: freshRoomClose }
    })
    const querySync = vi.fn(async () => [])

    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      refreshDirectMessageSubscriptions: () => void
      dmRelaySubs: Array<{ close: () => void }>
      dmSubscriptionStatus: { legacyEose: boolean; nip17Eose: boolean }
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
    relay.writeRelays = new Map()
    relay.dmSubscriptionGeneration = 0
    relay.dmSubscriptionStatus = { legacyEose: true, nip17Eose: true }

    relay.refreshDirectMessageSubscriptions()
    await vi.waitFor(() =>
      expect(roomSubscribe).toHaveBeenCalledWith(
        [...legacyDirectMessageReadFilters(pubkey), ...legacyDirectMessageWriteFilters(pubkey)],
        expect.objectContaining({ eoseTimeout: 3500 }),
      ),
    )

    expect(staleRoomClose).toHaveBeenCalledOnce()
    expect(staleRelayClose).toHaveBeenCalledOnce()
    expect(relay.dmSubscriptionStatus).toEqual({ legacyEose: false, nip17Eose: true })
    roomOptions?.oneose?.()
    expect(relay.dmSubscriptionStatus).toEqual({ legacyEose: true, nip17Eose: true })
    expect(relay.dmRelaySubs).toEqual([])
  })

  it('starts inbox subscriptions as soon as a signer is applied', () => {
    const pubkey = 'f'.repeat(64)
    const relay = new LiveNip29Relay(undefined, 'wss://relay.example') as unknown as Record<string, unknown> & {
      setSigner: (signer: { pubkey: string; label: string; signEvent: (event: NestrEventTemplate) => Promise<NestrEvent> }) => void
      refreshDirectMessageSubscriptions: () => void
      authenticateAndRefetch: () => Promise<void>
      fetchSavedSimpleGroups: (pubkey: string, options?: { showLoading?: boolean }) => Promise<void>
      emit: () => void
    }
    const refreshDirectMessageSubscriptions = vi
      .spyOn(relay, 'refreshDirectMessageSubscriptions')
      .mockImplementation(() => undefined)
    vi.spyOn(relay, 'authenticateAndRefetch').mockResolvedValue(undefined)
    vi.spyOn(relay, 'fetchSavedSimpleGroups').mockResolvedValue(undefined)
    vi.spyOn(relay, 'emit').mockImplementation(() => undefined)

    relay.setSigner({
      pubkey,
      label: 'test',
      signEvent: vi.fn(),
    })

    expect(refreshDirectMessageSubscriptions).toHaveBeenCalledOnce()
  })

  it('fetches saved relays and groups from the signer advertised write relays', async () => {
    const pubkey = '9'.repeat(64)
    const relayList: NestrEvent = {
      id: 'relay-list',
      sig: 'sig',
      pubkey,
      kind: 10002,
      created_at: 2,
      tags: [
        ['r', 'wss://read.example', 'read'],
        ['r', 'wss://write.example', 'write'],
      ],
      content: '',
    }
    const simpleGroups: NestrEvent = {
      id: 'simple-groups',
      sig: 'sig',
      pubkey,
      kind: NIP51_KINDS.simpleGroups,
      created_at: 3,
      tags: [
        ['r', 'wss://saved-relay.example'],
        ['group', 'room', 'wss://saved-relay.example', 'Saved room'],
      ],
      content: '',
    }
    const queryRelays = vi.fn(async (relays: string[], filterArg: unknown) => {
      const filter = filterArg as { kinds?: number[]; authors?: string[] }
      if (filter.kinds?.includes(10002)) return [relayList]
      if (filter.kinds?.includes(NIP51_KINDS.simpleGroups)) {
        return relays.includes('wss://write.example') ? [simpleGroups] : []
      }
      return []
    })
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      fetchSavedSimpleGroups: (pubkey: string, options?: { showLoading?: boolean }) => Promise<void>
      savedRelayUrls: Set<string>
      userSavedRelayUrls: Set<string>
      savedGroupKeys: Set<string>
    }
    relay.closed = false
    relay.relayUrl = 'wss://active.example'
    relay.signer = { pubkey, label: 'test', signEvent: vi.fn() }
    relay.queryRelays = queryRelays
    relay.readRelays = new Map()
    relay.writeRelays = new Map()
    relay.relayListEvents = new Map()
    relay.users = new Map()
    relay.profiles = new Map()
    relay.blossomServers = new Map()
    relay.dmRelays = new Map()
    relay.adminRoles = new Map()
    relay.memberPubkeys = new Set()
    relay.simpleGroupListEvents = new Map()
    relay.savedRelayUrls = new Set()
    relay.userSavedRelayUrls = new Set()
    relay.savedGroupKeys = new Set()
    relay.relayGroups = new Map()
    relay.savedGroupsLoading = false
    relay.emit = vi.fn()
    relay.fetchSavedGroupState = vi.fn()

    await relay.fetchSavedSimpleGroups(pubkey, { showLoading: false })
    relay.closed = true

    expect(queryRelays).toHaveBeenCalledWith(
      expect.arrayContaining(['wss://active.example', 'wss://purplepag.es', 'wss://relay.damus.io']),
      expect.objectContaining({ kinds: [10002], authors: [pubkey] }),
      3000,
    )
    expect(queryRelays).toHaveBeenCalledWith(
      expect.arrayContaining(['wss://write.example', 'wss://read.example']),
      expect.objectContaining({ kinds: [NIP51_KINDS.simpleGroups], authors: [pubkey] }),
      3200,
    )
    expect(relay.savedRelayUrls).toEqual(new Set(['wss://saved-relay.example']))
    expect(relay.userSavedRelayUrls).toEqual(new Set(['wss://saved-relay.example']))
    expect(relay.savedGroupKeys).toEqual(new Set([relayGroupKey('wss://saved-relay.example', 'room')]))
    expect(relay.fetchSavedGroupState).toHaveBeenCalledWith([
      expect.objectContaining({
        groupId: 'room',
        relayUrl: 'wss://saved-relay.example',
        name: 'Saved room',
      }),
    ])
  })

  it('allows active-relay author lookups for NIP-65 and NIP-51 startup lists', async () => {
    const pubkey = '1'.repeat(64)
    const relayListEvent: NestrEvent = {
      id: 'active-relay-list',
      sig: 'sig',
      pubkey,
      kind: 10002,
      created_at: 1,
      tags: [['r', 'wss://active.example', 'write']],
      content: '',
    }
    const simpleGroupsEvent: NestrEvent = {
      id: 'active-simple-groups',
      sig: 'sig',
      pubkey,
      kind: NIP51_KINDS.simpleGroups,
      created_at: 2,
      tags: [['r', 'wss://active.example']],
      content: '',
    }
    const roomSubscribe = vi.fn((filters: unknown, options: { onevent?: (event: NestrEvent) => void; oneose?: () => void }) => {
      const filter = Array.isArray(filters) ? filters[0] as { kinds?: number[] } : undefined
      options.onevent?.(filter?.kinds?.includes(NIP51_KINDS.simpleGroups) ? simpleGroupsEvent : relayListEvent)
      options.oneose?.()
      return { close: vi.fn() }
    })
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      queryRelays: (relays: string[], filter: { kinds: number[]; authors: string[] }, maxWait: number) => Promise<NestrEvent[]>
    }
    relay.closed = false
    relay.relayUrl = 'wss://active.example'
    relay.relay = { subscribe: roomSubscribe }
    relay.profilePool = { querySync: vi.fn(async () => []) }

    await expect(
      relay.queryRelays(['wss://active.example'], { kinds: [10002], authors: [pubkey] }, 50),
    ).resolves.toEqual([relayListEvent])
    await expect(
      relay.queryRelays(['wss://active.example'], { kinds: [NIP51_KINDS.simpleGroups], authors: [pubkey] }, 50),
    ).resolves.toEqual([simpleGroupsEvent])

    expect(roomSubscribe).toHaveBeenCalledTimes(2)
  })

  it('routes direct message subscriptions to the user advertised DM relays', async () => {
    const pubkey = 'c'.repeat(64)
    const roomSubscribe = vi.fn(() => ({ close: vi.fn() }))
    const profileSubscribe = vi.fn(() => ({ close: vi.fn() }))

    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      openDmRelaySubscriptions: () => Promise<void>
      dmRelaySubs: Array<{ close: () => void }>
    }
    relay.closed = false
    relay.relayUrl = 'wss://active.example'
    relay.signer = {
      pubkey,
      label: 'test',
      signEvent: vi.fn(),
    }
    relay.relay = { subscribe: roomSubscribe }
    relay.profilePool = { subscribe: profileSubscribe }
    relay.dmSub = undefined
    relay.dmRelaySubs = []
    relay.dmSubscriptionGeneration = 0
    relay.dmRelays = new Map([[pubkey, ['wss://nip17.example']]])
    relay.readRelays = new Map([[pubkey, ['wss://legacy-read.example']]])
    relay.writeRelays = new Map([[pubkey, ['wss://legacy-write.example']]])
    relay.receiveDirectMessage = vi.fn()

    await relay.openDmRelaySubscriptions()

    expect(roomSubscribe).not.toHaveBeenCalled()
    expect(profileSubscribe).toHaveBeenCalledWith(
      ['wss://nip17.example'],
      nip17DirectMessageSubscriptionFilters(pubkey)[0],
      expect.objectContaining({ eoseTimeout: 3500 }),
    )
    expect(profileSubscribe).toHaveBeenCalledWith(
      ['wss://legacy-read.example'],
      legacyDirectMessageReadFilters(pubkey)[0],
      expect.objectContaining({ eoseTimeout: 3500 }),
    )
    expect(profileSubscribe).toHaveBeenCalledWith(
      ['wss://legacy-write.example'],
      legacyDirectMessageWriteFilters(pubkey)[0],
      expect.objectContaining({ eoseTimeout: 3500 }),
    )
    expect(relay.dmRelaySubs).toHaveLength(3)
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
    expect(filters).toContainEqual({ kinds: [9021, 9022], '#h': ['room'], limit: 80 })
    expect(filters).not.toContainEqual({ kinds: [39000], limit: 240 })
    if (relay.roomAccessTimer) clearTimeout(relay.roomAccessTimer)
  })

  it('authenticates the relay and reloads the directory list after auth succeeds', async () => {
    const pubkey = 'e'.repeat(64)
    const oldGroup: NestrEvent = {
      id: 'old-directory-group',
      pubkey: 'a'.repeat(64),
      sig: 'sig',
      kind: NIP29_KINDS.groupMetadata,
      created_at: 1,
      tags: [
        ['d', 'old'],
        ['relay', 'wss://relay.example'],
      ],
      content: '',
    }
    const savedGroup: NestrEvent = {
      ...oldGroup,
      id: 'saved-other-group',
      tags: [
        ['d', 'saved'],
        ['relay', 'wss://other.example'],
      ],
    }
    const auth = vi.fn(async () => 'ok')
    const subscribe = vi.fn(() => ({ close: vi.fn() }))
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      authenticateAndRefetch: () => Promise<void>
      relayGroups: Map<string, NestrEvent>
      directoryGroupKeys: Set<string>
      roomAccessTimer?: ReturnType<typeof setTimeout>
      refreshDirectMessageSubscriptions: () => void
    }
    const oldGroupKey = relayGroupKey('wss://relay.example', 'old')
    const savedGroupKey = relayGroupKey('wss://other.example', 'saved')
    relay.closed = false
    relay.relayUrl = 'wss://relay.example'
    relay.hasSelectedGroup = false
    relay.groupId = ''
    relay.relayGroups = new Map([
      [oldGroupKey, oldGroup],
      [savedGroupKey, savedGroup],
    ])
    relay.directoryGroupKeys = new Set([oldGroupKey])
    relay.connectionStatus = 'connected'
    relay.connectionMessage = 'connected'
    relay.connectionLog = []
    relay.roomAccessStatus = 'open'
    relay.groupSub = undefined
    relay.dmRelaySubs = []
    relay.signer = {
      pubkey,
      label: 'test',
      signEvent: vi.fn(),
    }
    relay.relay = { auth, subscribe }
    relay.emit = vi.fn()
    relay.refreshDirectMessageSubscriptions = vi.fn()

    await relay.authenticateAndRefetch()

    expect(auth).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledWith(
      [{ kinds: [39000], limit: 240 }],
      expect.objectContaining({ eoseTimeout: 3500 }),
    )
    expect(relay.relayGroups.has(oldGroupKey)).toBe(false)
    expect(relay.relayGroups.get(savedGroupKey)).toBe(savedGroup)
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

  it('falls back to users advertised write relays for missing profile metadata in batches', async () => {
    const alice = 'a'.repeat(64)
    const bob = 'b'.repeat(64)
    const relayList = (pubkey: string): NestrEvent => ({
      id: `relay-${pubkey.slice(0, 1)}`,
      sig: 'sig',
      pubkey,
      kind: 10002,
      created_at: 2,
      tags: [['r', 'wss://write.example', 'write']],
      content: '',
    })
    const profile = (pubkey: string, name: string): NestrEvent => ({
      id: `profile-${pubkey.slice(0, 1)}`,
      sig: 'sig',
      pubkey,
      kind: 0,
      created_at: 3,
      tags: [],
      content: JSON.stringify({ name }),
    })
    const profileQuery = vi.fn(async (relays: string[], filterArg: unknown) => {
      const filter = filterArg as { kinds?: number[]; authors?: string[] }
      if (filter.kinds?.includes(10002) && filter.kinds.includes(0)) {
        return [relayList(alice), relayList(bob)]
      }
      if (
        relays.length === 1 &&
        relays[0] === 'wss://write.example' &&
        filter.kinds?.includes(0) &&
        filter.authors?.includes(alice) &&
        filter.authors.includes(bob)
      ) {
        return [profile(alice, 'Alice'), profile(bob, 'Bob')]
      }
      return []
    })
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      fetchQueuedProfiles: () => Promise<void>
      users: Map<string, { name: string }>
    }
    relay.closed = false
    relay.relayUrl = 'wss://groups.0xchat.com'
    relay.profilePool = { querySync: profileQuery }
    relay.profileQueue = new Set([alice, bob])
    relay.profiles = new Map()
    relay.users = new Map()
    relay.blossomServers = new Map()
    relay.dmRelays = new Map()
    relay.dmRelayEvents = new Map()
    relay.relayListEvents = new Map()
    relay.readRelays = new Map()
    relay.writeRelays = new Map()
    relay.adminRoles = new Map()
    relay.memberPubkeys = new Set()
    relay.emit = vi.fn()

    await relay.fetchQueuedProfiles()

    expect(profileQuery).toHaveBeenCalledWith(
      ['wss://purplepag.es', 'wss://relay.damus.io'],
      expect.objectContaining({
        kinds: [0, 10050, 10063, 10002],
        authors: [alice, bob],
      }),
      { maxWait: 2600 },
    )
    expect(profileQuery).toHaveBeenCalledWith(
      ['wss://write.example'],
      expect.objectContaining({
        kinds: [0, 10063],
        authors: [alice, bob],
      }),
      { maxWait: 2600 },
    )
    expect(relay.users.get(alice)?.name).toBe('Alice')
    expect(relay.users.get(bob)?.name).toBe('Bob')
  })

  it('saves the current relay by publishing the public NIP-51 relay tag', async () => {
    const pubkey = '8'.repeat(64)
    const publish = vi.fn(async () => 'ok')
    const signEvent = vi.fn(async (template: NestrEventTemplate) => ({
      ...template,
      id: 'saved-list',
      sig: 'sig',
      pubkey,
    }))
    const previous: NestrEvent = {
      id: 'previous-list',
      sig: 'sig',
      pubkey,
      kind: NIP51_KINDS.simpleGroups,
      created_at: 1,
      tags: [
        ['group', 'room', 'wss://groups.example', 'Room'],
        ['r', 'wss://relay.old'],
      ],
      content: 'encrypted-private-items',
    }
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      publishSaveRelay: LiveNip29Relay['publishSaveRelay']
    }
    relay.relayUrl = 'wss://groups.example'
    relay.signer = { pubkey, label: 'test', signEvent }
    relay.relay = { publish }
    relay.simpleGroupListEvents = new Map([[pubkey, previous]])
    relay.savedRelayUrls = new Set()
    relay.userSavedRelayUrls = new Set()
    relay.savedGroupKeys = new Set()
    relay.relayGroups = new Map()
    relay.connectionStatus = 'connected'
    relay.connectionMessage = 'connected'
    relay.connectionLog = []
    relay.emit = vi.fn()
    relay.fetchSavedGroupState = vi.fn()

    await expect(relay.publishSaveRelay(pubkey, 'groups.example')).resolves.toMatchObject({ ok: true })

    expect(signEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: NIP51_KINDS.simpleGroups,
      content: 'encrypted-private-items',
      tags: expect.arrayContaining([
        ['group', 'room', 'wss://groups.example', 'Room'],
        ['r', 'wss://relay.old'],
        ['r', 'wss://groups.example'],
      ]),
    }))
    expect(relay.userSavedRelayUrls).toEqual(new Set(['wss://relay.old', 'wss://groups.example']))
  })

  it('removes only the explicit NIP-51 relay tag and preserves saved groups', async () => {
    const pubkey = '7'.repeat(64)
    const publish = vi.fn(async () => 'ok')
    const signEvent = vi.fn(async (template: NestrEventTemplate) => ({
      ...template,
      id: 'removed-list',
      sig: 'sig',
      pubkey,
    }))
    const previous: NestrEvent = {
      id: 'previous-list',
      sig: 'sig',
      pubkey,
      kind: NIP51_KINDS.simpleGroups,
      created_at: 1,
      tags: [
        ['r', 'wss://groups.example/'],
        ['group', 'room', 'wss://groups.example', 'Room'],
        ['r', 'wss://relay.keep'],
      ],
      content: '',
    }
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      publishRemoveRelay: LiveNip29Relay['publishRemoveRelay']
    }
    relay.relayUrl = 'wss://groups.example'
    relay.signer = { pubkey, label: 'test', signEvent }
    relay.relay = { publish }
    relay.simpleGroupListEvents = new Map([[pubkey, previous]])
    relay.savedRelayUrls = new Set()
    relay.userSavedRelayUrls = new Set(['wss://groups.example', 'wss://relay.keep'])
    relay.savedGroupKeys = new Set()
    relay.relayGroups = new Map()
    relay.connectionStatus = 'connected'
    relay.connectionMessage = 'connected'
    relay.connectionLog = []
    relay.emit = vi.fn()
    relay.fetchSavedGroupState = vi.fn()

    await expect(relay.publishRemoveRelay(pubkey, 'groups.example')).resolves.toMatchObject({ ok: true })

    const signedTags = signEvent.mock.calls[0]?.[0].tags ?? []
    expect(signedTags).not.toContainEqual(['r', 'wss://groups.example'])
    expect(signedTags).toContainEqual(['group', 'room', 'wss://groups.example', 'Room'])
    expect(signedTags).toContainEqual(['r', 'wss://relay.keep'])
    expect(relay.userSavedRelayUrls).toEqual(new Set(['wss://relay.keep']))
  })

  it('treats active relay directory metadata as local to the relay that returned it', () => {
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      receive: (event: NestrEvent) => void
      relayGroups: Map<string, NestrEvent>
      savedRelayUrls: Set<string>
      directoryGroupKeys: Set<string>
    }
    relay.relayUrl = 'wss://active.example'
    relay.hasSelectedGroup = false
    relay.relayGroups = new Map()
    relay.savedRelayUrls = new Set()
    relay.directoryGroupKeys = new Set()
    relay.emit = vi.fn()

    relay.receive({
      id: 'metadata',
      pubkey: 'a'.repeat(64),
      sig: 'sig',
      kind: NIP29_KINDS.groupMetadata,
      created_at: 1,
      tags: [
        ['d', 'room'],
        ['relay', 'wss://wrong.example'],
        ['name', 'Room'],
      ],
      content: '',
    })

    const stored = relay.relayGroups.get(relayGroupKey('wss://active.example', 'room'))
    expect(stored).toBeDefined()
    expect(relay.relayGroups.has(relayGroupKey('wss://wrong.example', 'room'))).toBe(false)
    expect(relayUrlFromGroupEvent(stored!, '')).toBe('wss://active.example')
    expect(relay.savedRelayUrls).toEqual(new Set(['wss://active.example']))
  })

  it('records relay publish errors for the UI toast', async () => {
    const pubkey = '6'.repeat(64)
    const message = 'restricted: you are not a member of this relay'
    const publish = vi.fn(async () => {
      throw new Error(message)
    })
    const signEvent = vi.fn(async (template: NestrEventTemplate) => ({
      ...template,
      id: 'create-room',
      sig: 'sig',
      pubkey,
    }))
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      publishCreateGroup: LiveNip29Relay['publishCreateGroup']
      connectionStatus: string
      connectionMessage: string
    }
    relay.relayUrl = 'wss://groups.example'
    relay.groupId = ''
    relay.signer = { pubkey, label: 'test', signEvent }
    relay.relay = { publish }
    relay.connectionStatus = 'connected'
    relay.connectionMessage = 'connected'
    relay.setConnection = vi.fn((status: string, nextMessage: string) => {
      relay.connectionStatus = status
      relay.connectionMessage = nextMessage
    })
    relay.emit = vi.fn()

    await expect(relay.publishCreateGroup(pubkey, 'Room', 'room')).resolves.toMatchObject({
      ok: false,
      reason: message,
    })

    expect(relay.relayError).toMatchObject({
      kind: NIP29_KINDS.createGroup,
      eventId: 'create-room',
      message,
    })
  })

  it('refreshes selected group state after a join request is approved elsewhere', async () => {
    const pubkey = '9'.repeat(64)
    const memberEvent: NestrEvent = {
      id: 'members',
      sig: 'sig',
      pubkey: 'a'.repeat(64),
      kind: NIP29_KINDS.groupMembers,
      created_at: 1,
      tags: [
        ['d', 'room'],
        ['p', pubkey],
      ],
      content: '',
    }
    const roomClose = vi.fn()
    const roomSubscribe = vi.fn((filtersArg: unknown, optionsArg: { onevent?: (event: NestrEvent) => void; oneose?: () => void }) => {
      void filtersArg
      setTimeout(() => {
        optionsArg.onevent?.(memberEvent)
        optionsArg.oneose?.()
      }, 0)
      return { close: roomClose }
    })
    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      refreshGroupState: LiveNip29Relay['refreshGroupState']
    }
    relay.closed = false
    relay.hasSelectedGroup = true
    relay.groupId = 'room'
    relay.relayUrl = 'wss://groups.0xchat.com'
    relay.roomAccessStatus = 'blocked'
    relay.roomAccessMessage = 'blocked'
    relay.memberPubkeys = new Set()
    relay.adminRoles = new Map()
    relay.group = {
      metadata: { tags: [], pubkey: 'a'.repeat(64) },
      admins: { tags: [] },
      members: { tags: [] },
      roles: { tags: [] },
    }
    relay.users = new Map()
    relay.profiles = new Map()
    relay.blossomServers = new Map()
    relay.dmRelays = new Map()
    relay.readRelays = new Map()
    relay.writeRelays = new Map()
    relay.relayGroups = new Map()
    relay.relay = { subscribe: roomSubscribe }
    relay.queueProfileFetch = vi.fn()
    relay.refreshPresenceSubscription = vi.fn()
    relay.openGroupSubscription = vi.fn()
    relay.emit = vi.fn()

    await relay.refreshGroupState(50)

    expect(roomSubscribe).toHaveBeenCalledWith(
      [
        { kinds: [39000, 39001, 39002, 39003], '#d': ['room'], limit: 32 },
        { kinds: [9021, 9022], '#h': ['room'], limit: 80 },
        { '#h': ['room'], limit: 180 },
      ],
      expect.objectContaining({ eoseTimeout: 50 }),
    )
    expect(relay.memberPubkeys).toEqual(new Set([pubkey]))
    expect(relay.roomAccessStatus).toBe('open')
    expect(relay.openGroupSubscription).toHaveBeenCalledOnce()
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
    expect(relay.relayError).toBeUndefined()
  })

  it('re-signs a call signal when the relay rejects a late-approved event as too old', async () => {
    const pubkey = 'a'.repeat(64)
    const targetPubkey = 'b'.repeat(64)
    const publish = vi
      .fn<(event: NestrEvent) => Promise<string>>()
      .mockRejectedValueOnce(new Error('blocked: event too old'))
      .mockResolvedValueOnce('ok')
    const signEvent = vi.fn(async (template: NestrEventTemplate) => ({
      ...template,
      id: `signed-call-${signEvent.mock.calls.length}`,
      sig: 'sig',
      pubkey,
    }))

    const relay = Object.create(LiveNip29Relay.prototype) as Record<string, unknown> & {
      publishCallSignal: LiveNip29Relay['publishCallSignal']
      connectionStatus: string
      connectionMessage: string
    }
    relay.hasSelectedGroup = true
    relay.groupId = 'room'
    relay.signer = { pubkey, label: 'test', signEvent }
    relay.relay = { publish }
    relay.connectionStatus = 'connected'
    relay.connectionMessage = 'connected'
    relay.setConnection = vi.fn((status: string, message: string) => {
      relay.connectionStatus = status
      relay.connectionMessage = message
    })
    relay.emit = vi.fn()

    await expect(
      relay.publishCallSignal(pubkey, OFFICE_KINDS.iceCandidate, targetPubkey, {
        candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
      }),
    ).resolves.toMatchObject({ ok: true })

    expect(signEvent).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.calls[0]?.[0].id).toBe('signed-call-1')
    expect(publish.mock.calls[1]?.[0].id).toBe('signed-call-2')
    expect(relay.relayError).toBeUndefined()
  })
})
