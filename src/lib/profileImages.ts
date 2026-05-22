export interface ProfileMetadata {
  name?: string
  display_name?: string
  displayName?: string
  username?: string
  nip05?: string
  picture?: string
  image?: string
  avatar?: string
}

export interface BlossomPointer {
  hash: string
  extension: string
  servers: string[]
  authors: string[]
}

const BLOSSOM_FALLBACK_SERVERS = [
  'https://blossom.primal.net',
  'https://blossom.nostr.build',
  'https://cdn.satellite.earth',
]

function parseProfile(content: string) {
  try {
    return JSON.parse(content) as ProfileMetadata
  } catch {
    return null
  }
}

function normalizeServer(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    url.search = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function extensionFromValue(value: string) {
  const match = value.match(/\.([a-z0-9]{2,8})(?:[?#].*)?$/i)
  return match?.[1]?.toLowerCase() ?? 'png'
}

export function profileNameFromContent(content: string) {
  const profile = parseProfile(content)
  if (!profile) return null

  const candidates = [
    profile.display_name,
    profile.displayName,
    profile.name,
    profile.username,
    profile.nip05,
  ]
  return candidates.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? null
}

export function profilePictureFromContent(content: string) {
  const profile = parseProfile(content)
  if (!profile) return null

  const candidates = [profile.picture, profile.image, profile.avatar]
  return candidates.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? null
}

export function extractBlossomPointer(value: string, authorPubkey?: string): BlossomPointer | null {
  const trimmed = value.trim()
  const directHash = trimmed.match(/(?:^|\/)([0-9a-f]{64})(?:\.([a-z0-9]{2,8}))?(?:[?#].*)?$/i)

  if (trimmed.startsWith('blossom:')) {
    const match = trimmed.match(/^blossom:([0-9a-f]{64})(?:\.([a-z0-9]{2,8}))?(?:\?(.*))?$/i)
    if (!match) return null

    const params = new URLSearchParams(match[3] ?? '')
    const servers = params.getAll('xs').map((server) => normalizeServer(server)).filter((server) => server !== null)
    const authors = params
      .getAll('as')
      .filter((pubkey) => /^[0-9a-f]{64}$/i.test(pubkey))
      .map((pubkey) => pubkey.toLowerCase())

    return {
      hash: match[1].toLowerCase(),
      extension: (match[2] ?? 'png').toLowerCase(),
      servers,
      authors,
    }
  }

  if (directHash) {
    return {
      hash: directHash[1].toLowerCase(),
      extension: (directHash[2] ?? extensionFromValue(trimmed)).toLowerCase(),
      servers: [],
      authors: authorPubkey ? [authorPubkey] : [],
    }
  }

  return null
}

function blossomUrl(server: string, pointer: Pick<BlossomPointer, 'hash' | 'extension'>) {
  return `${server}/${pointer.hash}.${pointer.extension}`
}

export function buildProfilePictureCandidates(
  value: string | null | undefined,
  authorPubkey: string,
  authorServers: string[] = [],
) {
  if (!value) return []

  const trimmed = value.trim()
  const pointer = extractBlossomPointer(trimmed, authorPubkey)
  const isHttpUrl = /^https?:\/\//i.test(trimmed)

  if (!pointer) {
    return isHttpUrl ? [trimmed] : []
  }

  const serverHints = pointer.servers.length > 0 ? pointer.servers : []
  const trustedServers = authorServers.map((server) => normalizeServer(server)).filter((server) => server !== null)
  const servers = unique([...serverHints, ...trustedServers, ...BLOSSOM_FALLBACK_SERVERS])
  const blossomCandidates = servers.map((server) => blossomUrl(server, pointer))

  return unique([...(isHttpUrl ? [trimmed] : []), ...blossomCandidates])
}

export function blossomServersFromTags(tags: string[][]) {
  return unique(
    tags
      .filter((tag) => tag[0] === 'server' && tag[1])
      .map((tag) => normalizeServer(tag[1]))
      .filter((server) => server !== null),
  )
}
