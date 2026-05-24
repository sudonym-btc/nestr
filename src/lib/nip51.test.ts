import { describe, expect, it } from 'vitest'
import { parseSimpleGroupsEvent } from './nip51'
import { NIP51_KINDS, type NestrEvent } from './nostr'

function event(tags: string[][]): NestrEvent {
  return {
    id: 'simple-groups',
    pubkey: 'a'.repeat(64),
    created_at: 1,
    kind: NIP51_KINDS.simpleGroups,
    tags,
    content: '',
    sig: 'sig',
  }
}

describe('NIP-51 simple groups', () => {
  it('parses group tags into relay-local pointers', () => {
    const parsed = parseSimpleGroupsEvent(event([
      ['group', 'general', 'groups.0xchat.com', 'General'],
      ['group', 'product', 'wss://relay.example/', 'Product'],
      ['r', 'https://public.example'],
    ]))

    expect(parsed?.groups).toEqual([
      { groupId: 'general', relayUrl: 'wss://groups.0xchat.com', name: 'General' },
      { groupId: 'product', relayUrl: 'wss://relay.example', name: 'Product' },
    ])
    expect(parsed?.relays).toEqual([
      'wss://groups.0xchat.com',
      'wss://relay.example',
      'wss://public.example',
    ])
  })

  it('ignores malformed and duplicate group tags', () => {
    const parsed = parseSimpleGroupsEvent(event([
      ['group', '', 'wss://relay.example', 'Missing group'],
      ['group', 'alpha', '', 'Missing relay'],
      ['group', 'alpha', 'wss://relay.example', 'Alpha'],
      ['group', 'alpha', 'wss://relay.example', 'Duplicate'],
    ]))

    expect(parsed?.groups).toEqual([
      { groupId: 'alpha', relayUrl: 'wss://relay.example', name: 'Alpha' },
    ])
  })
})
