import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip04 from 'nostr-tools/nip04'
import { unwrapNip04DirectMessage } from './nip04'
import { DM_KINDS, type NestrEvent, type NestrSigner } from './nostr'

function localSigner(secretKey: Uint8Array, label: string): NestrSigner {
  const pubkey = getPublicKey(secretKey)

  return {
    pubkey,
    label,
    signEvent: async (event) => finalizeEvent(event, secretKey),
    nip04Decrypt: async (thirdPartyPubkey, ciphertext) => nip04.decrypt(secretKey, thirdPartyPubkey, ciphertext),
  }
}

function legacyDm(secretKey: Uint8Array, recipientPubkey: string, content: string, createdAt: number): NestrEvent {
  return finalizeEvent(
    {
      kind: DM_KINDS.legacyDirectMessage,
      created_at: createdAt,
      tags: [['p', recipientPubkey]],
      content: nip04.encrypt(secretKey, recipientPubkey, content),
    },
    secretKey,
  ) as NestrEvent
}

describe('nip04 legacy direct messages', () => {
  it('unwraps an incoming legacy direct message into the common DM model', async () => {
    const aliceSecret = generateSecretKey()
    const alice = localSigner(aliceSecret, 'alice')
    const bob = localSigner(generateSecretKey(), 'bob')
    const event = legacyDm(aliceSecret, bob.pubkey, 'legacy hello', 1_700_000_000)

    const message = await unwrapNip04DirectMessage(bob, event)

    expect(message).toMatchObject({
      id: event.id,
      eventId: event.id,
      counterparty: alice.pubkey,
      senderPubkey: alice.pubkey,
      recipientPubkey: bob.pubkey,
      content: 'legacy hello',
      createdAt: 1_700_000_000,
      protocol: 'nip04',
    })
  })

  it('unwraps a sent legacy direct message without exposing any send helper', async () => {
    const aliceSecret = generateSecretKey()
    const alice = localSigner(aliceSecret, 'alice')
    const bob = localSigner(generateSecretKey(), 'bob')
    const event = legacyDm(aliceSecret, bob.pubkey, 'legacy sent copy', 1_700_000_100)

    const message = await unwrapNip04DirectMessage(alice, event)

    expect(message?.counterparty).toBe(bob.pubkey)
    expect(message?.senderPubkey).toBe(alice.pubkey)
    expect(message?.recipientPubkey).toBe(bob.pubkey)
    expect(message?.content).toBe('legacy sent copy')
  })
})
