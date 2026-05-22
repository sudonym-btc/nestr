import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { BunkerSigner, createNostrConnectURI, type BunkerPointer } from 'nostr-tools/nip46'
import { NostrConnect } from 'nostr-tools/kinds'
import { decrypt, getConversationKey } from 'nostr-tools/nip44'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Relay } from 'nostr-tools/relay'
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
  'sign_event:24242',
]

export const DEFAULT_NOSTR_CONNECT_RELAYS = [
  'wss://relay.nsec.app',
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
  void roomRelayUrl
  const source = explicitRelays.length > 0 ? explicitRelays : DEFAULT_NOSTR_CONNECT_RELAYS

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
  ready: Promise<void>
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

interface NostrConnectResponse {
  result?: unknown
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

function abortError() {
  return new Error('Nostr Connect cancelled')
}

function parseConnectResponse(clientSecretKey: Uint8Array, event: { pubkey: string; content: string }, secret: string) {
  const conversationKey = getConversationKey(clientSecretKey, event.pubkey)
  const response = JSON.parse(decrypt(event.content, conversationKey)) as NostrConnectResponse
  return response.result === secret
}

function waitForNostrConnectBunker(
  clientSecretKey: Uint8Array,
  relays: string[],
  secret: string,
  signal: AbortSignal,
) {
  const clientPubkey = getPublicKey(clientSecretKey)
  const since = Math.floor(Date.now() / 1000) - 600
  const relayConnections: Relay[] = []
  const subscriptions: ReturnType<Relay['subscribe']>[] = []
  let settled = false
  let activeSubscriptions = 0
  let resolveReady: () => void = () => undefined
  let rejectReady: (error: Error) => void = () => undefined
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const waitForBunker = new Promise<BunkerPointer>((resolve, reject) => {
    const cleanup = () => {
      subscriptions.splice(0).forEach((subscription) => subscription.close('nostr-connect-complete'))
      relayConnections.splice(0).forEach((relay) => relay.close())
    }

    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      cleanup()
      reject(error)
    }

    const resolveOnce = (pointer: BunkerPointer) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      cleanup()
      resolve(pointer)
    }

    const onAbort = () => rejectOnce(abortError())
    signal.addEventListener('abort', onAbort, { once: true })

    Promise.allSettled(
      relays.map(async (relayUrl) => {
        const relay = await Relay.connect(relayUrl, { enableReconnect: true })
        if (signal.aborted) throw abortError()

        relayConnections.push(relay)
        activeSubscriptions += 1
        const subscription = relay.subscribe(
          [
            {
              kinds: [NostrConnect],
              '#p': [clientPubkey],
              since,
              limit: 10,
            },
          ],
          {
            onevent: (event) => {
              try {
                if (parseConnectResponse(clientSecretKey, event, secret)) {
                  signal.removeEventListener('abort', onAbort)
                  resolveOnce({ pubkey: event.pubkey, relays, secret })
                }
              } catch {
                // Other NIP-46 traffic for this client pubkey is ignored.
              }
            },
            onclose: (reason) => {
              activeSubscriptions -= 1
              if (activeSubscriptions <= 0 && !settled) {
                rejectOnce(new Error(reason || 'Nostr Connect listener closed'))
              }
            },
            eoseTimeout: 300_000,
            abort: signal,
          },
        )
        subscriptions.push(subscription)
      }),
    ).then((results) => {
      if (settled) return
      const connected = results.some((result) => result.status === 'fulfilled')
      if (!connected) {
        const reason = results
          .map((result) => (result.status === 'rejected' ? String(result.reason) : ''))
          .filter(Boolean)
          .join('; ')
        const error = new Error(reason || 'Could not connect to Nostr Connect relay')
        rejectReady(error)
        rejectOnce(error)
        return
      }

      resolveReady()
    })
  })

  waitForBunker.catch(() => undefined)

  return { ready, waitForBunker }
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
  const listener = waitForNostrConnectBunker(clientSecretKey, relays, connectionSecret, controller.signal)

  const waitForSigner = listener.waitForBunker.then(async (bunkerPointer) => {
    const signer = BunkerSigner.fromBunker(clientSecretKey, bunkerPointer, {
      onauth: openAuthUrl,
      skipSwitchRelays: true,
    })
    const onAbort = () => {
      void signer.close().catch(() => undefined)
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })

    try {
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
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
    }
  })

  return {
    uri,
    relays,
    ready: listener.ready,
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
