import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { NestrAttachment, NestrEvent, NestrSigner } from './nostr'
import { BLOSSOM_FALLBACK_SERVERS } from './profileImages'

const encoder = new TextEncoder()

export interface BlossomUploadOptions {
  signer?: NestrSigner | null
  servers?: string[]
  encrypt?: boolean
  allowLocalFallback?: boolean
}

interface BlossomDescriptor {
  url?: string
  sha256?: string
  size?: number
  type?: string
}

function now() {
  return Math.floor(Date.now() / 1000)
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function normalizeServer(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function extensionForFile(file: File) {
  const nameMatch = file.name.match(/\.([a-z0-9]{2,12})$/i)
  if (nameMatch) return nameMatch[1].toLowerCase()

  const typeMatch = file.type.match(/\/([a-z0-9.+-]+)$/i)
  return typeMatch?.[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'bin'
}

async function sha256Hex(blob: Blob) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function eventAuthorizationHeader(event: NestrEvent) {
  return `Nostr ${bytesToBase64Url(encoder.encode(JSON.stringify(event)))}`
}

function hexKeyFromCryptoKey(key: CryptoKey) {
  return crypto.subtle.exportKey('raw', key).then((raw) => bytesToHex(new Uint8Array(raw)))
}

async function encryptedUploadBlob(file: File) {
  const originalSha256 = await sha256Hex(file)
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, await file.arrayBuffer())
  const blob = new Blob([ciphertext], { type: 'application/octet-stream' })

  return {
    blob,
    originalSha256,
    sha256: await sha256Hex(blob),
    decryptionKey: await hexKeyFromCryptoKey(key),
    decryptionNonce: bytesToHex(nonce),
  }
}

async function blossomAuthHeader(signer: NestrSigner, server: string, sha256: string, fileName: string) {
  const hostname = new URL(server).hostname.toLowerCase()
  const signed = await signer.signEvent({
    kind: 24242,
    created_at: now(),
    tags: [
      ['t', 'upload'],
      ['expiration', String(now() + 10 * 60)],
      ['x', sha256],
      ['server', hostname],
    ],
    content: `Upload ${fileName}`,
  })

  return eventAuthorizationHeader(signed)
}

async function uploadToServer(server: string, blob: Blob, sha256: string, file: File, signer?: NestrSigner | null) {
  const headers: Record<string, string> = {
    'Content-Type': blob.type || file.type || 'application/octet-stream',
    'X-SHA-256': sha256,
  }

  if (signer) headers.Authorization = await blossomAuthHeader(signer, server, sha256, file.name)

  const response = await fetch(`${server}/upload`, {
    method: 'PUT',
    headers,
    body: blob,
  })

  if (!response.ok) {
    throw new Error(response.headers.get('X-Reason') || `${server} upload failed with ${response.status}`)
  }

  const descriptor = (await response.json()) as BlossomDescriptor
  const extension = extensionForFile(file)

  return {
    url: descriptor.url || `${server}/${sha256}.${extension}`,
    sha256: descriptor.sha256 || sha256,
    size: descriptor.size ?? blob.size,
    type: descriptor.type || blob.type || file.type || 'application/octet-stream',
  }
}

function localAttachment(file: File, sha256?: string, encrypted?: Awaited<ReturnType<typeof encryptedUploadBlob>>) {
  const source = encrypted?.blob ?? file
  const url = URL.createObjectURL(source)

  return {
    url,
    localUrl: url,
    name: file.name || `${sha256 ?? 'local-file'}.${extensionForFile(file)}`,
    mimeType: file.type || 'application/octet-stream',
    size: source.size,
    sha256: encrypted?.sha256 ?? sha256,
    originalSha256: encrypted?.originalSha256 ?? sha256,
    encrypted: Boolean(encrypted),
    encryptionAlgorithm: encrypted ? 'aes-gcm' : undefined,
    decryptionKey: encrypted?.decryptionKey,
    decryptionNonce: encrypted?.decryptionNonce,
  } satisfies NestrAttachment
}

export async function prepareFileAttachment(file: File, options: BlossomUploadOptions = {}) {
  if (options.allowLocalFallback && !options.encrypt) return localAttachment(file)

  const originalSha256 = await sha256Hex(file)
  const encrypted = options.encrypt ? await encryptedUploadBlob(file) : undefined
  const uploadBlob = encrypted?.blob ?? file
  const uploadSha256 = encrypted?.sha256 ?? originalSha256

  if (options.allowLocalFallback) return localAttachment(file, originalSha256, encrypted)

  const servers = unique(
    [...(options.servers ?? []), ...BLOSSOM_FALLBACK_SERVERS]
      .map((server) => normalizeServer(server))
      .filter((server) => server !== null),
  )

  const errors: string[] = []
  for (const server of servers) {
    try {
      const descriptor = await uploadToServer(server, uploadBlob, uploadSha256, file, options.signer)
      return {
        url: descriptor.url,
        name: file.name || `${uploadSha256}.${extensionForFile(file)}`,
        mimeType: file.type || descriptor.type || 'application/octet-stream',
        size: descriptor.size,
        sha256: descriptor.sha256,
        originalSha256,
        encrypted: Boolean(encrypted),
        encryptionAlgorithm: encrypted ? 'aes-gcm' : undefined,
        decryptionKey: encrypted?.decryptionKey,
        decryptionNonce: encrypted?.decryptionNonce,
      } satisfies NestrAttachment
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  throw new Error(errors[0] || 'No Blossom upload server accepted the file')
}

export async function decryptAttachmentBlob(attachment: NestrAttachment) {
  if (!attachment.encrypted) {
    const response = await fetch(attachment.url)
    if (!response.ok) throw new Error(`Could not download ${attachment.name}`)
    return response.blob()
  }

  if (!attachment.decryptionKey || !attachment.decryptionNonce) {
    throw new Error(`Missing decryption details for ${attachment.name}`)
  }

  const response = await fetch(attachment.localUrl ?? attachment.url)
  if (!response.ok) throw new Error(`Could not download ${attachment.name}`)
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(attachment.decryptionKey),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(attachment.decryptionNonce) },
    key,
    await response.arrayBuffer(),
  )

  return new Blob([plaintext], { type: attachment.mimeType || 'application/octet-stream' })
}
