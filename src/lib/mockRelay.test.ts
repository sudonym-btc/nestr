import { describe, expect, it } from 'vitest'
import { seededPubkey } from './avatar'
import { createMockRelay } from './mockRelay'
import { OFFICE_KINDS } from './nostr'
import { memberPubkeys } from './nip29'
import { buildOfficeMap } from './world'

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

  it('publishes room and direct-message attachments', () => {
    const relay = createMockRelay()
    const [sender, recipient] = relay.snapshot().users
    const attachment = {
      url: 'blob:mock-file',
      name: 'mock.txt',
      mimeType: 'text/plain',
      size: 12,
      sha256: 'a'.repeat(64),
    }

    const groupResult = relay.publishGroupMessage(sender.pubkey, 'file attached', [attachment])
    const directResult = relay.publishDirectMessage(sender.pubkey, recipient.pubkey, '', [attachment])
    const latestGroup = relay.snapshot().messages.at(-1)
    const latestDm = relay.snapshot().directMessages.at(-1)

    expect(groupResult.ok).toBe(true)
    expect(latestGroup?.tags.some((tag) => tag[0] === 'imeta')).toBe(true)
    expect(latestGroup?.content).toContain(attachment.url)
    expect(directResult.ok).toBe(true)
    expect(latestDm?.attachments?.[0]).toMatchObject(attachment)
  })

  it('publishes office movement as ephemeral position events', () => {
    const relay = createMockRelay()
    const user = relay.snapshot().users[0]
    const before = relay.snapshot().eventCount
    const result = relay.publishPosition(user.pubkey, {
      startX: 120,
      startY: 160,
      endX: 220,
      endY: 160,
      speed: 100,
    })
    const after = relay.snapshot()
    expect(result.ok).toBe(true)
    expect(after.eventCount).toBe(before)
    const position = after.positions.find((candidate) => candidate.pubkey === user.pubkey)
    expect(position?.x).toBeGreaterThanOrEqual(120)
    expect(position?.x).toBeLessThan(130)

    const replacement = relay.publishPosition(user.pubkey, {
      startX: 220,
      startY: 160,
      endX: 320,
      endY: 160,
      speed: 100,
    })
    expect(replacement.ok).toBe(true)
    expect(relay.snapshot().eventCount).toBe(before)
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

  it('keeps mock streaming users still while ticking bots', () => {
    const relay = createMockRelay()
    const snapshot = relay.snapshot()
    const frozenUser = snapshot.users[1]
    const movingUser = snapshot.users[2]
    const beforeFrozen = snapshot.positions.find((position) => position.pubkey === frozenUser.pubkey)
    const beforeMoving = snapshot.positions.find((position) => position.pubkey === movingUser.pubkey)

    relay.tickBots(snapshot.users[0].pubkey, buildOfficeMap(snapshot.group.id, snapshot.users.length), [
      frozenUser.pubkey,
    ])

    const after = relay.snapshot()
    const afterFrozen = after.positions.find((position) => position.pubkey === frozenUser.pubkey)
    const afterMoving = after.positions.find((position) => position.pubkey === movingUser.pubkey)

    expect(afterFrozen?.x).toBe(beforeFrozen?.x)
    expect(afterFrozen?.y).toBe(beforeFrozen?.y)
    expect(afterMoving?.x).not.toBe(beforeMoving?.x)
  })

  it('supports NIP-29 join requests and admin acceptance with put-user', () => {
    const relay = createMockRelay()
    const admin = relay.snapshot().users[0]
    const guestPubkey = seededPubkey('join-requester')

    const request = relay.publishJoinRequest(guestPubkey, 'let me in')
    expect(request.ok).toBe(true)
    expect(relay.snapshot().joinRequests.map((event) => event.pubkey)).toContain(guestPubkey)

    const accept = relay.publishPutUser(admin.pubkey, guestPubkey, [], 'accepted')
    const snapshot = relay.snapshot()

    expect(accept.ok).toBe(true)
    expect(snapshot.joinRequests.map((event) => event.pubkey)).not.toContain(guestPubkey)
    expect(memberPubkeys(snapshot.group.members)).toContain(guestPubkey)
  })

  it('creates invite codes that can preauthorize NIP-29 join requests', () => {
    const relay = createMockRelay()
    const admin = relay.snapshot().users[0]
    const guestPubkey = seededPubkey('invited-user')

    expect(relay.publishCreateInvite(admin.pubkey, 'desk-42').ok).toBe(true)
    expect(relay.publishJoinRequest(guestPubkey, 'invite', 'desk-42').ok).toBe(true)

    const snapshot = relay.snapshot()
    expect(snapshot.invites.length).toBe(1)
    expect(snapshot.joinRequests.map((event) => event.pubkey)).not.toContain(guestPubkey)
    expect(memberPubkeys(snapshot.group.members)).toContain(guestPubkey)
  })

  it('supports remove-user, edit-metadata, and delete-event moderation', () => {
    const relay = createMockRelay()
    const admin = relay.snapshot().users[0]
    const member = relay.snapshot().users[2]
    const message = relay.snapshot().messages[0]

    expect(relay.publishRemoveUser(admin.pubkey, member.pubkey, 'kick').ok).toBe(true)
    expect(memberPubkeys(relay.snapshot().group.members)).not.toContain(member.pubkey)

    expect(
      relay.publishEditMetadata(admin.pubkey, {
        name: 'Renamed Office',
        about: 'Updated by test',
        picture: '',
        private: true,
        restricted: true,
        closed: true,
        hidden: false,
      }).ok,
    ).toBe(true)
    expect(relay.snapshot().group.metadata.tags).toContainEqual(['name', 'Renamed Office'])
    expect(relay.snapshot().group.metadata.tags).toContainEqual(['closed'])

    expect(relay.publishDeleteEvent(admin.pubkey, message.id, 'delete').ok).toBe(true)
    expect(relay.snapshot().messages.map((event) => event.id)).not.toContain(message.id)
    expect(relay.snapshot().deletedEventIds).toContain(message.id)
  })
})
