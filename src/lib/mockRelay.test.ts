import { describe, expect, it } from 'vitest'
import { createMockRelay } from './mockRelay'
import { OFFICE_KINDS } from './nostr'

describe('mock NIP-29 relay', () => {
  it('seeds relay-generated group metadata and global chat', () => {
    const relay = createMockRelay()
    const snapshot = relay.snapshot()
    expect(snapshot.group.metadata.kind).toBe(39000)
    expect(snapshot.group.metadata.tags).toContainEqual(['d', snapshot.group.id])
    expect(snapshot.messages.length).toBeGreaterThan(0)
    expect(snapshot.messages.every((event) => event.tags.some((tag) => tag[0] === 'h'))).toBe(true)
  })

  it('publishes NIP-29 chat messages to the global room timeline', () => {
    const relay = createMockRelay()
    const user = relay.snapshot().users[0]
    const result = relay.publishGroupMessage(user.pubkey, 'hello room')
    const latest = relay.snapshot().messages.at(-1)
    expect(result.ok).toBe(true)
    expect(latest?.content).toBe('hello room')
    expect(latest?.tags).toContainEqual(['h', relay.snapshot().group.id])
  })

  it('keeps office movement ephemeral while updating active positions', () => {
    const relay = createMockRelay()
    const user = relay.snapshot().users[0]
    const before = relay.snapshot().eventCount
    const result = relay.publishPosition(user.pubkey, 120, 160, 1, 0)
    const after = relay.snapshot()
    expect(result.ok).toBe(true)
    expect(after.eventCount).toBe(before)
    expect(after.positions.find((position) => position.pubkey === user.pubkey)?.x).toBe(120)
  })

  it('rejects malformed group events without the h tag', () => {
    const relay = createMockRelay()
    const user = relay.snapshot().users[0]
    const result = relay.publish({
      id: 'x',
      sig: 'x',
      kind: OFFICE_KINDS.avatarPosition,
      pubkey: user.pubkey,
      created_at: 1,
      tags: [],
      content: '{}',
    })
    expect(result.ok).toBe(false)
  })
})
