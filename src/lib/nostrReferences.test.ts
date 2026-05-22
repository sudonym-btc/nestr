import { describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import { parseNostrReferences, profilePubkeysFromReferences } from './nostrReferences'

describe('nostr reference parsing', () => {
  const pubkey = 'f'.repeat(64)
  const eventId = 'a'.repeat(64)

  it('parses NIP-21 profile references in text', () => {
    const code = nip19.nprofileEncode({ pubkey })
    const parts = parseNostrReferences(`hello nostr:${code}`)

    expect(parts).toMatchObject([
      { type: 'text', text: 'hello ' },
      { type: 'entity', entityType: 'profile', pubkey, code },
    ])
  })

  it('parses bare NIP-19 event ids and links to njump', () => {
    const code = nip19.noteEncode(eventId)
    const parts = parseNostrReferences(`see ${code}.`)
    const entity = parts.find((part) => part.type === 'entity')

    expect(entity).toMatchObject({
      type: 'entity',
      entityType: 'event',
      eventId,
      href: `https://njump.me/${code}`,
    })
  })

  it('resolves legacy NIP-27 bracket references through tags', () => {
    const parts = parseNostrReferences('hi #[0]', [['p', pubkey, 'wss://relay.example']])
    expect(parts.at(-1)).toMatchObject({
      type: 'entity',
      entityType: 'profile',
      pubkey,
    })
  })

  it('extracts profile pubkeys from parsed references', () => {
    const code = nip19.npubEncode(pubkey)
    expect(profilePubkeysFromReferences(`cc ${code}`)).toEqual([pubkey])
  })
})
