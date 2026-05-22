import { finalizeEvent, generateSecretKey, getEventHash } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import {
  DM_KINDS,
  type NestrDirectMessage,
  type NestrEvent,
  type NestrEventTemplate,
  type NestrSigner,
} from './nostr'

const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60

interface Rumor {
  id: string
  pubkey: string
  kind: number
  tags: string[][]
  content: string
  created_at: number
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function fuzzyPastTimestamp() {
  return nowSeconds() - Math.floor(Math.random() * TWO_DAYS_SECONDS)
}

function assertNip44Signer(signer: NestrSigner) {
  if (!signer.nip44Encrypt || !signer.nip44Decrypt) {
    throw new Error(`${signer.label} does not expose NIP-44 encryption for NIP-17 DMs`)
  }
}

function buildRumor(senderPubkey: string, recipientPubkey: string, content: string, createdAt: number): Rumor {
  const unsigned = {
    kind: DM_KINDS.directMessage,
    pubkey: senderPubkey,
    created_at: createdAt,
    tags: [['p', recipientPubkey]],
    content,
  }

  return {
    ...unsigned,
    id: getEventHash(unsigned),
  }
}

async function createSeal(signer: NestrSigner, rumor: Rumor, recipientPubkey: string) {
  assertNip44Signer(signer)
  const content = await signer.nip44Encrypt!(recipientPubkey, JSON.stringify(rumor))
  return signer.signEvent({
    kind: DM_KINDS.seal,
    created_at: fuzzyPastTimestamp(),
    tags: [],
    content,
  })
}

function createWrap(seal: NestrEvent, recipientPubkey: string): NestrEvent {
  const secretKey = generateSecretKey()
  const conversationKey = nip44.utils.getConversationKey(secretKey, recipientPubkey)
  const content = nip44.encrypt(JSON.stringify(seal), conversationKey)

  return finalizeEvent(
    {
      kind: DM_KINDS.giftWrap,
      created_at: fuzzyPastTimestamp(),
      tags: [['p', recipientPubkey]],
      content,
    },
    secretKey,
  ) as NestrEvent
}

export async function createNip17DirectMessage(
  signer: NestrSigner,
  recipientPubkey: string,
  content: string,
  createdAt = nowSeconds(),
) {
  assertNip44Signer(signer)
  const rumor = buildRumor(signer.pubkey, recipientPubkey, content, createdAt)
  const recipients = Array.from(new Set([recipientPubkey, signer.pubkey]))
  const wraps: NestrEvent[] = []

  for (const recipient of recipients) {
    const seal = await createSeal(signer, rumor, recipient)
    wraps.push(createWrap(seal, recipient))
  }

  const message: NestrDirectMessage = {
    id: rumor.id,
    counterparty: recipientPubkey,
    senderPubkey: signer.pubkey,
    recipientPubkey,
    content,
    createdAt,
    protocol: 'nip17',
  }

  return { message, wraps }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseJsonEvent(value: string): NestrEvent | null {
  try {
    const parsed = JSON.parse(value)
    if (!isRecord(parsed)) return null
    if (typeof parsed.kind !== 'number') return null
    if (typeof parsed.pubkey !== 'string') return null
    if (typeof parsed.content !== 'string') return null
    if (typeof parsed.created_at !== 'number') return null
    if (!Array.isArray(parsed.tags)) return null
    return parsed as unknown as NestrEvent
  } catch {
    return null
  }
}

function parseRumor(value: string): Rumor | null {
  try {
    const parsed = JSON.parse(value)
    if (!isRecord(parsed)) return null
    if (parsed.kind !== DM_KINDS.directMessage) return null
    if (typeof parsed.id !== 'string') return null
    if (typeof parsed.pubkey !== 'string') return null
    if (typeof parsed.content !== 'string') return null
    if (typeof parsed.created_at !== 'number') return null
    if (!Array.isArray(parsed.tags)) return null
    return parsed as unknown as Rumor
  } catch {
    return null
  }
}

export async function unwrapNip17DirectMessage(
  signer: Pick<NestrSigner, 'pubkey' | 'nip44Decrypt'>,
  wrap: NestrEvent,
): Promise<NestrDirectMessage | null> {
  if (wrap.kind !== DM_KINDS.giftWrap || !signer.nip44Decrypt) return null

  try {
    const sealJson = await signer.nip44Decrypt(wrap.pubkey, wrap.content)
    const seal = parseJsonEvent(sealJson)
    if (!seal || seal.kind !== DM_KINDS.seal) return null

    const rumorJson = await signer.nip44Decrypt(seal.pubkey, seal.content)
    const rumor = parseRumor(rumorJson)
    if (!rumor || rumor.pubkey !== seal.pubkey) return null

    const taggedRecipients = rumor.tags
      .filter((tag) => tag[0] === 'p' && tag[1])
      .map((tag) => tag[1])
    const recipientPubkey = taggedRecipients[0] ?? signer.pubkey
    const senderPubkey = rumor.pubkey
    const counterparty = senderPubkey === signer.pubkey ? recipientPubkey : senderPubkey

    if (senderPubkey !== signer.pubkey && !taggedRecipients.includes(signer.pubkey)) {
      return null
    }

    return {
      id: rumor.id,
      eventId: wrap.id,
      counterparty,
      senderPubkey,
      recipientPubkey,
      content: rumor.content,
      createdAt: rumor.created_at,
      protocol: 'nip17',
    }
  } catch {
    return null
  }
}

export function hasNip44Signer(signer: NestrSigner | null | undefined) {
  return Boolean(signer?.nip44Encrypt && signer.nip44Decrypt)
}

export type Nip17MessageTemplate = NestrEventTemplate
