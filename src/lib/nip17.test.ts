import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { createNip17DirectMessage, unwrapNip17DirectMessage } from './nip17'
import type { NestrSigner } from './nostr'

function localSigner(secretKey: Uint8Array, label: string): NestrSigner {
  const pubkey = getPublicKey(secretKey)

  return {
    pubkey,
    label,
    signEvent: async (event) => finalizeEvent(event, secretKey),
    nip44Encrypt: async (thirdPartyPubkey, plaintext) => {
      const conversationKey = nip44.utils.getConversationKey(secretKey, thirdPartyPubkey)
      return nip44.encrypt(plaintext, conversationKey)
    },
    nip44Decrypt: async (thirdPartyPubkey, ciphertext) => {
      const conversationKey = nip44.utils.getConversationKey(secretKey, thirdPartyPubkey)
      return nip44.decrypt(ciphertext, conversationKey)
    },
  }
}

describe('nip17 direct messages', () => {
  it('wraps a message for the recipient and retained sender copy', async () => {
    const alice = localSigner(generateSecretKey(), 'alice')
    const bob = localSigner(generateSecretKey(), 'bob')

    const { message, wraps } = await createNip17DirectMessage(alice, bob.pubkey, 'hello bob', 1_700_000_000)

    expect(message.protocol).toBe('nip17')
    expect(wraps).toHaveLength(2)
    expect(wraps.every((wrap) => wrap.kind === 1059)).toBe(true)

    const forBob = wraps.find((wrap) => wrap.tags.some((tag) => tag[0] === 'p' && tag[1] === bob.pubkey))
    const unwrapped = await unwrapNip17DirectMessage(bob, forBob!)

    expect(unwrapped?.content).toBe('hello bob')
    expect(unwrapped?.senderPubkey).toBe(alice.pubkey)
    expect(unwrapped?.counterparty).toBe(alice.pubkey)
  })

  it('lets the sender decrypt their retained copy', async () => {
    const alice = localSigner(generateSecretKey(), 'alice')
    const bob = localSigner(generateSecretKey(), 'bob')

    const { wraps } = await createNip17DirectMessage(alice, bob.pubkey, 'kept copy', 1_700_000_100)
    const forAlice = wraps.find((wrap) => wrap.tags.some((tag) => tag[0] === 'p' && tag[1] === alice.pubkey))
    const unwrapped = await unwrapNip17DirectMessage(alice, forAlice!)

    expect(unwrapped?.content).toBe('kept copy')
    expect(unwrapped?.counterparty).toBe(bob.pubkey)
    expect(unwrapped?.recipientPubkey).toBe(bob.pubkey)
  })

  it('wraps encrypted file messages with kind 15 metadata', async () => {
    const alice = localSigner(generateSecretKey(), 'alice')
    const bob = localSigner(generateSecretKey(), 'bob')
    const attachment = {
      url: 'https://cdn.example/secret.bin',
      name: 'secret.png',
      mimeType: 'image/png',
      size: 2048,
      sha256: 'a'.repeat(64),
      originalSha256: 'b'.repeat(64),
      encrypted: true,
      encryptionAlgorithm: 'aes-gcm' as const,
      decryptionKey: 'c'.repeat(64),
      decryptionNonce: 'd'.repeat(24),
    }

    const { message, wraps } = await createNip17DirectMessage(alice, bob.pubkey, '', 1_700_000_200, {
      attachment,
    })
    const forBob = wraps.find((wrap) => wrap.tags.some((tag) => tag[0] === 'p' && tag[1] === bob.pubkey))
    const unwrapped = await unwrapNip17DirectMessage(bob, forBob!)

    expect(message.attachments?.[0]).toMatchObject(attachment)
    expect(unwrapped?.content).toBe('secret.png')
    expect(unwrapped?.attachments?.[0]).toMatchObject(attachment)
  })
})
