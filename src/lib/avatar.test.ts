import { describe, expect, it } from 'vitest'
import { avatarFromPubkey, npubForPubkey, resolvePubkey, seededPubkey } from './avatar'

describe('avatar identity helpers', () => {
  it('resolves npubs back to pubkeys', () => {
    const pubkey = seededPubkey('alice')
    expect(resolvePubkey(npubForPubkey(pubkey))).toBe(pubkey)
  })

  it('derives stable avatar styles from pubkeys', () => {
    const pubkey = seededPubkey('stable-avatar')
    expect(avatarFromPubkey(pubkey)).toEqual(avatarFromPubkey(pubkey))
  })

  it('turns a non-npub handle into a deterministic mock pubkey', () => {
    expect(resolvePubkey('som')).toBe(resolvePubkey('som'))
    expect(resolvePubkey('som')).not.toBe(resolvePubkey('brad'))
  })
})
