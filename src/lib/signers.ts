import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { BunkerSigner, createNostrConnectURI, type BunkerPointer } from 'nostr-tools/nip46'
import { NostrConnect } from 'nostr-tools/kinds'
import { decrypt, getConversationKey } from 'nostr-tools/nip44'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Relay } from 'nostr-tools/relay'
import type { NestrSigner } from './nostr'
import { debugDuration, debugError, debugLog, debugWarn, shortId } from './debugLog'

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
      nip04?: {
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
  'nip04_decrypt',
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
  'sign_event:10009',
  'sign_event:25050',
  'sign_event:25051',
  'sign_event:25052',
  'sign_event:25053',
  'sign_event:25055',
  'sign_event:25029',
  'sign_event:22242',
  'sign_event:24242',
]

export const DEFAULT_NOSTR_CONNECT_RELAYS = [
  'wss://relay.nsec.app',
] as const

const RESTORE_PROBE_TIMEOUT_MS = 2_500
const RESTORE_PROBE_RETRY_DELAY_MS = 650
const RESTORE_PROBE_ATTEMPTS = 2

function normalizeRelayUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const withScheme = trimmed.includes('://') ? trimmed : `wss://${trimmed}`
    const url = new URL(withScheme)
    if (url.protocol === 'https:') url.protocol = 'wss:'
    if (url.protocol === 'http:') url.protocol = 'ws:'
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return trimmed.replace(/\/$/, '')
  }
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
    nip04Decrypt: window.nostr.nip04?.decrypt
      ? (thirdPartyPubkey, ciphertext) => window.nostr!.nip04!.decrypt(thirdPartyPubkey, ciphertext)
      : undefined,
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

export function nostrConnectStoredRelayHints(storedSession: NostrConnectStoredSession | null | undefined) {
  if (!storedSession) return []

  const relayUrls = Array.isArray(storedSession.relayUrls) ? storedSession.relayUrls : []
  const pointerRelays = Array.isArray(storedSession.bunkerPointer?.relays)
    ? storedSession.bunkerPointer.relays
    : []
  return Array.from(
    new Set(
      [...relayUrls, storedSession.relayUrl, ...pointerRelays]
        .filter((relayUrl): relayUrl is string => typeof relayUrl === 'string')
        .map(normalizeRelayUrl)
        .filter(Boolean),
    ),
  )
}

export function normalizeStoredNostrConnectSession(storedSession: NostrConnectStoredSession) {
  const relayHints = nostrConnectStoredRelayHints(storedSession)
  const relays = relayHints.length > 0 ? relayHints : [...DEFAULT_NOSTR_CONNECT_RELAYS]

  return {
    ...storedSession,
    relayUrl: relays[0],
    relayUrls: relays,
    bunkerPointer: {
      ...storedSession.bunkerPointer,
      relays,
    },
  }
}

function openAuthUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function isHexPubkey(value: string) {
  return /^[0-9a-f]{64}$/i.test(value)
}

function delay(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

function requestWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  return Promise.race([
    promise.finally(() => {
      if (timer) globalThis.clearTimeout(timer)
    }),
    timeout,
  ])
}

async function probeRestoredSigner(signer: BunkerSigner, storedPubkey: string) {
  const canUseStoredPubkey = isHexPubkey(storedPubkey)
  let lastError: unknown

  for (let attempt = 0; attempt < RESTORE_PROBE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(RESTORE_PROBE_RETRY_DELAY_MS)
    const startedAt = performance.now()

    try {
      if (canUseStoredPubkey) {
        debugLog('nip46', 'restore probe ping start', {
          attempt: attempt + 1,
          pubkey: shortId(storedPubkey),
          timeoutMs: RESTORE_PROBE_TIMEOUT_MS,
        })
        await requestWithTimeout(signer.ping(), RESTORE_PROBE_TIMEOUT_MS, 'signer ping timed out')
        debugLog('nip46', 'restore probe ping ok', {
          attempt: attempt + 1,
          pubkey: shortId(storedPubkey),
          elapsedMs: debugDuration(startedAt),
        })
        return storedPubkey
      }

      debugLog('nip46', 'restore probe getPublicKey start', {
        attempt: attempt + 1,
        timeoutMs: RESTORE_PROBE_TIMEOUT_MS,
      })
      const pubkey = await requestWithTimeout(
        signer.getPublicKey(),
        RESTORE_PROBE_TIMEOUT_MS,
        'signer public key fetch timed out',
      )
      debugLog('nip46', 'restore probe getPublicKey ok', {
        attempt: attempt + 1,
        pubkey: shortId(pubkey),
        elapsedMs: debugDuration(startedAt),
      })
      return pubkey
    } catch (error) {
      lastError = error
      debugWarn('nip46', 'restore probe attempt failed', {
        attempt: attempt + 1,
        pubkey: shortId(storedPubkey),
        elapsedMs: debugDuration(startedAt),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  throw lastError instanceof Error ? lastError : new Error('signer reconnect probe failed')
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
  debugLog('nip46', 'waiting for Nostr Connect bunker', {
    clientPubkey: shortId(clientPubkey),
    relays,
    since,
  })
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
        debugLog('nip46', 'connecting Nostr Connect relay', { relayUrl })
        const relay = await Relay.connect(relayUrl, { enableReconnect: true })
        if (signal.aborted) throw abortError()

        relayConnections.push(relay)
        activeSubscriptions += 1
        debugLog('nip46', 'subscribing for bunker response', {
          relayUrl,
          clientPubkey: shortId(clientPubkey),
        })
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
                  debugLog('nip46', 'bunker response matched', {
                    relayUrl,
                    bunkerPubkey: shortId(event.pubkey),
                  })
                  signal.removeEventListener('abort', onAbort)
                  resolveOnce({ pubkey: event.pubkey, relays, secret })
                }
              } catch {
                // Other NIP-46 traffic for this client pubkey is ignored.
              }
            },
            onclose: (reason) => {
              activeSubscriptions -= 1
              debugWarn('nip46', 'bunker listener closed', { relayUrl, reason })
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
        debugError('nip46', 'failed to connect Nostr Connect relays', { relays, reason })
        rejectReady(error)
        rejectOnce(error)
        return
      }

      debugLog('nip46', 'Nostr Connect listener ready', { relays })
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
    nip04Decrypt: (thirdPartyPubkey, ciphertext) => signer.nip04Decrypt(thirdPartyPubkey, ciphertext),
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
  debugLog('nip46', 'startNostrConnect', {
    clientPubkey: shortId(clientPubkey),
    relays,
    roomRelayUrl: options.roomRelayUrl,
  })
  const uri = createNostrConnectURI({
    clientPubkey,
    relays,
    secret: connectionSecret,
    perms: NESTR_NIP46_PERMISSIONS,
    ...appMetadata,
  })
  const listener = waitForNostrConnectBunker(clientSecretKey, relays, connectionSecret, controller.signal)

  const waitForSigner = listener.waitForBunker.then(async (bunkerPointer) => {
    const startedAt = performance.now()
    debugLog('nip46', 'creating signer from bunker', {
      bunkerPubkey: shortId(bunkerPointer.pubkey),
      relays: bunkerPointer.relays,
    })
    const signer = BunkerSigner.fromBunker(clientSecretKey, bunkerPointer, {
      onauth: openAuthUrl,
      skipSwitchRelays: true,
    })
    const onAbort = () => {
      void signer.close().catch(() => undefined)
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })

    try {
      debugLog('nip46', 'initial getPublicKey start', { bunkerPubkey: shortId(bunkerPointer.pubkey) })
      const pubkey = await signer.getPublicKey()
      debugLog('nip46', 'initial getPublicKey ok', {
        pubkey: shortId(pubkey),
        elapsedMs: debugDuration(startedAt),
      })
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

export async function restoreNostrConnectSigner(storedSession: NostrConnectStoredSession): Promise<NostrConnectResult> {
  const normalizedSession = normalizeStoredNostrConnectSession(storedSession)
  debugLog('nip46', 'restoreNostrConnectSigner start', {
    userPubkey: shortId(normalizedSession.userPubkey),
    bunkerPubkey: shortId(normalizedSession.bunkerPointer.pubkey),
    relays: nostrConnectStoredRelayHints(normalizedSession),
  })
  const signer = BunkerSigner.fromBunker(hexToBytes(normalizedSession.clientSecretKey), normalizedSession.bunkerPointer, {
    onauth: openAuthUrl,
    skipSwitchRelays: true,
  })
  let pubkey: string

  try {
    pubkey = await probeRestoredSigner(signer, normalizedSession.userPubkey)
  } catch (error) {
    debugError('nip46', 'restore probe failed; closing signer', {
      error: error instanceof Error ? error.message : String(error),
    })
    await signer.close().catch(() => undefined)
    throw error
  }

  const refreshedSession = normalizeStoredNostrConnectSession({
    ...normalizedSession,
    bunkerPointer: signer.bp,
    userPubkey: pubkey,
  })
  return {
    signer: signerAdapter(signer, pubkey),
    storedSession: refreshedSession,
  }
}
