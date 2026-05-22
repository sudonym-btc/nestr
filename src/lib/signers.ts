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
      nip44?: {
        encrypt: (pubkey: string, plaintext: string) => Promise<string>
        decrypt: (pubkey: string, ciphertext: string) => Promise<string>
      }
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
  'ping',
  'nip44_encrypt',
  'nip44_decrypt',
  'sign_event:13',
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

export const DEFAULT_NOSTR_CONNECT_RELAYS = [
  'wss://relay.nsec.app',
  'wss://relay.damus.io',
] as const

function normalizeRelayUrl(value: string) {
  const withScheme = value.includes('://') ? value : `wss://${value}`
  const url = new URL(withScheme)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function nostrConnectRelayHints(roomRelayUrl: string, explicitRelays: string[] = []) {
  const source = explicitRelays.length > 0
    ? explicitRelays
    : [...DEFAULT_NOSTR_CONNECT_RELAYS, roomRelayUrl]

  return Array.from(new Set(source.map(normalizeRelayUrl)))
}

export async function connectNip07Signer(): Promise<NestrSigner> {
  if (!window.nostr) {
    throw new Error('No NIP-07 browser signer found')
  }

  const pubkey = await window.nostr.getPublicKey()
  return {
    pubkey,
    label: 'NIP-07',
    signEvent: (event) => window.nostr!.signEvent(event),
    nip44Encrypt: window.nostr.nip44?.encrypt
      ? (thirdPartyPubkey, plaintext) => window.nostr!.nip44!.encrypt(thirdPartyPubkey, plaintext)
      : undefined,
    nip44Decrypt: window.nostr.nip44?.decrypt
      ? (thirdPartyPubkey, ciphertext) => window.nostr!.nip44!.decrypt(thirdPartyPubkey, ciphertext)
      : undefined,
    ping: async () => {
      const current = await window.nostr!.getPublicKey()
      if (current !== pubkey) throw new Error('NIP-07 signer switched accounts')
    },
  }
}

export interface NostrConnectSession {
  uri: string
  relays: string[]
  waitForSigner: Promise<NostrConnectResult>
  abort: () => void
}

export interface NostrConnectStoredSession {
  version: 1
  clientSecretKey: string
  bunkerPointer: BunkerPointer
  userPubkey: string
  relayUrl: string
  relayUrls?: string[]
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
    nip44Encrypt: (thirdPartyPubkey, plaintext) => signer.nip44Encrypt(thirdPartyPubkey, plaintext),
    nip44Decrypt: (thirdPartyPubkey, ciphertext) => signer.nip44Decrypt(thirdPartyPubkey, ciphertext),
    ping: () => signer.ping(),
    close: () => signer.close(),
  }
}

export interface NostrConnectStartOptions {
  roomRelayUrl: string
  nostrConnectRelays?: string[]
}

export function startNostrConnect(options: NostrConnectStartOptions): NostrConnectSession {
  const clientSecretKey = generateSecretKey()
  const clientSecretHex = bytesToHex(clientSecretKey)
  const clientPubkey = getPublicKey(clientSecretKey)
  const controller = new AbortController()
  const connectionSecret = randomHex(16)
  const appMetadata = nostrConnectAppMetadata(window.location.origin)
  const relays = nostrConnectRelayHints(options.roomRelayUrl, options.nostrConnectRelays)
  const uri = createNostrConnectURI({
    clientPubkey,
    relays,
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
        relayUrl: relays[0],
        relayUrls: relays,
        connectedAt: Date.now(),
      },
    }
  })

  return {
    uri,
    relays,
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
