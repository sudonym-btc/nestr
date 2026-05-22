import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { nip19 } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools/pure'

const textEncoder = new TextEncoder()

const PALETTES = [
  { body: '#2454d6', trim: '#dbe6ff', skin: '#c98763', hair: '#292532' },
  { body: '#176348', trim: '#dceee2', skin: '#a86c4b', hair: '#1d1715' },
  { body: '#e46f58', trim: '#ffe3d9', skin: '#d09a72', hair: '#34211a' },
  { body: '#7257c7', trim: '#e6ddff', skin: '#8b5f48', hair: '#19151f' },
  { body: '#d9982a', trim: '#fff0c8', skin: '#b87957', hair: '#2e241b' },
  { body: '#23728a', trim: '#dff5f7', skin: '#d6a078', hair: '#1b2529' },
]

export interface AvatarStyle {
  pubkey: string
  npub: string
  body: string
  trim: string
  skin: string
  hair: string
  pattern: number
  badge: string
}

export function seededSecret(seed: string) {
  return sha256(textEncoder.encode(`nestr:${seed}`))
}

export function seededPubkey(seed: string) {
  return getPublicKey(seededSecret(seed))
}

export function npubForPubkey(pubkey: string) {
  return nip19.npubEncode(pubkey)
}

export function shortNpub(pubkey: string) {
  const npub = npubForPubkey(pubkey)
  return `${npub.slice(0, 10)}...${npub.slice(-4)}`
}

export function resolvePubkey(value: string) {
  const trimmed = value.trim()

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase()
  }

  if (trimmed.startsWith('npub1')) {
    const decoded = nip19.decode(trimmed)
    if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
      throw new Error('Expected an npub identifier')
    }

    return decoded.data
  }

  if (trimmed.length > 0) {
    return seededPubkey(trimmed)
  }

  throw new Error('Enter an npub or handle')
}

export function avatarFromPubkey(pubkey: string): AvatarStyle {
  const bytes = sha256(hexToBytes(pubkey))
  const palette = PALETTES[bytes[0] % PALETTES.length]
  const badge = bytesToHex(bytes).slice(0, 2).toUpperCase()

  return {
    pubkey,
    npub: npubForPubkey(pubkey),
    ...palette,
    pattern: bytes[1] % 4,
    badge,
  }
}

export function avatarCss(pubkey: string) {
  const avatar = avatarFromPubkey(pubkey)
  return {
    '--avatar-body': avatar.body,
    '--avatar-trim': avatar.trim,
    '--avatar-skin': avatar.skin,
    '--avatar-hair': avatar.hair,
  } as React.CSSProperties
}
