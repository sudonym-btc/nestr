import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { BunkerSigner, createNostrConnectURI, type BunkerPointer } from 'nostr-tools/nip46'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { NestrSigner } from './nostr'

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>
      signEvent: (event: {
        kind: number
        tags: string[][]
        content: string
        created_at: number
      }) => Promise<{
        id: string
        pubkey: string
        kind: number
        tags: string[][]
        content: string
        created_at: number
        sig: string
      }>
    }
  }
}

function randomHex(bytes = 16) {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return bytesToHex(buffer)
}

export const NESTR_NIP46_PERMISSIONS = [
  'get_public_key',
  'sign_event:9',
  'sign_event:9000',
  'sign_event:9001',
  'sign_event:9002',
  'sign_event:9005',
  'sign_event:9007',
  'sign_event:9008',
  'sign_event:9009',
  'sign_event:9021',
  'sign_event:9022',
  'sign_event:25029',
  'sign_event:22242',
]

export async function connectNip07Signer(): Promise<NestrSigner> {
  if (!window.nostr) {
    throw new Error('No NIP-07 browser signer found')
  }

  const pubkey = await window.nostr.getPublicKey()
  return {
    pubkey,
    label: 'NIP-07',
    signEvent: (event) => window.nostr!.signEvent(event),
  }
}

export interface NostrConnectSession {
  uri: string
  waitForSigner: Promise<NostrConnectResult>
  abort: () => void
}

export interface NostrConnectStoredSession {
  version: 1
  clientSecretKey: string
  bunkerPointer: BunkerPointer
  userPubkey: string
  relayUrl: string
  connectedAt: number
}

export interface NostrConnectResult {
  signer: NestrSigner
  storedSession: NostrConnectStoredSession
}

export function nostrConnectAppMetadata(origin: string) {
  return {
    name: 'Nestr',
    url: origin,
    image: new URL('/favicon.svg', origin).toString(),
  }
}

function openAuthUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function signerAdapter(signer: BunkerSigner, pubkey: string): NestrSigner {
  return {
    pubkey,
    label: 'NIP-46',
    signEvent: (event) => signer.signEvent(event),
  }
}

export function startNostrConnect(relayUrl: string): NostrConnectSession {
  const clientSecretKey = generateSecretKey()
  const clientSecretHex = bytesToHex(clientSecretKey)
  const clientPubkey = getPublicKey(clientSecretKey)
  const controller = new AbortController()
  const connectionSecret = randomHex(16)
  const appMetadata = nostrConnectAppMetadata(window.location.origin)
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: [relayUrl],
    secret: connectionSecret,
    perms: NESTR_NIP46_PERMISSIONS,
    ...appMetadata,
  })

  const waitForSigner = BunkerSigner.fromURI(
    clientSecretKey,
    uri,
    {
      onauth: openAuthUrl,
      skipSwitchRelays: true,
    },
    controller.signal,
  ).then(async (signer) => {
    const pubkey = await signer.getPublicKey()
    return {
      signer: signerAdapter(signer, pubkey),
      storedSession: {
        version: 1 as const,
        clientSecretKey: clientSecretHex,
        bunkerPointer: signer.bp,
        userPubkey: pubkey,
        relayUrl,
        connectedAt: Date.now(),
      },
    }
  })

  return {
    uri,
    waitForSigner,
    abort: () => controller.abort('cancelled'),
  }
}

export async function restoreNostrConnectSigner(storedSession: NostrConnectStoredSession) {
  const signer = BunkerSigner.fromBunker(hexToBytes(storedSession.clientSecretKey), storedSession.bunkerPointer, {
    onauth: openAuthUrl,
    skipSwitchRelays: true,
  })
  const pubkey = await signer.getPublicKey()
  return signerAdapter(signer, pubkey)
}
