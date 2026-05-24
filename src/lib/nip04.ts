import {
  DM_KINDS,
  tagValues,
  type NestrDirectMessage,
  type NestrEvent,
  type NestrSigner,
} from './nostr'

export async function unwrapNip04DirectMessage(
  signer: Pick<NestrSigner, 'pubkey' | 'nip04Decrypt'>,
  event: NestrEvent,
): Promise<NestrDirectMessage | null> {
  if (event.kind !== DM_KINDS.legacyDirectMessage || !signer.nip04Decrypt) return null

  const recipients = tagValues(event, 'p').filter(Boolean)
  const outgoing = event.pubkey === signer.pubkey
  const incoming = recipients.includes(signer.pubkey)
  if (!outgoing && !incoming) return null

  const peerPubkey = outgoing ? recipients.find((recipient) => recipient !== signer.pubkey) ?? signer.pubkey : event.pubkey
  if (!peerPubkey) return null

  try {
    const content = await signer.nip04Decrypt(peerPubkey, event.content)
    const recipientPubkey = outgoing ? peerPubkey : signer.pubkey

    return {
      id: event.id,
      eventId: event.id,
      counterparty: peerPubkey,
      senderPubkey: event.pubkey,
      recipientPubkey,
      content,
      createdAt: event.created_at,
      protocol: 'nip04',
    }
  } catch {
    return null
  }
}
