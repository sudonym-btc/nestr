import type { NestrAttachment, NestrEvent } from './nostr'

const URL_PATTERN = /^(https?:|blob:|data:)/i

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function tagEntry(key: string, value: string | number | undefined) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  return `${key} ${String(value)}`
}

function parseImetaEntry(entry: string) {
  const separator = entry.indexOf(' ')
  if (separator <= 0) return null
  return [entry.slice(0, separator), entry.slice(separator + 1)] as const
}

function tagValue(tags: string[][], name: string) {
  return tags.find((tag) => tag[0] === name && tag[1])?.[1]
}

function normalizedName(value: string | undefined, url: string) {
  const trimmed = value?.trim()
  if (trimmed) return trimmed

  try {
    const pathname = new URL(url).pathname
    const segment = pathname.split('/').filter(Boolean).at(-1)
    return segment || 'attachment'
  } catch {
    return 'attachment'
  }
}

function normalizedMimeType(value: string | undefined) {
  return value?.trim() || 'application/octet-stream'
}

function normalizedSize(value: string | number | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export function attachmentTags(attachments: NestrAttachment[]) {
  return attachments.map((attachment) =>
    [
      'imeta',
      tagEntry('url', attachment.url),
      tagEntry('m', attachment.mimeType),
      tagEntry('name', attachment.name),
      tagEntry('size', attachment.size),
      tagEntry('x', attachment.sha256),
      tagEntry('ox', attachment.originalSha256),
      tagEntry('dim', attachment.dim),
      tagEntry('alt', attachment.alt),
    ].filter((entry): entry is string => Boolean(entry)),
  )
}

export function attachmentsFromTags(tags: string[][]) {
  return tags
    .filter((tag) => tag[0] === 'imeta')
    .map((tag): NestrAttachment | null => {
      const fields = new Map<string, string[]>()

      tag.slice(1).forEach((entry) => {
        const parsed = parseImetaEntry(entry)
        if (!parsed) return
        const [key, value] = parsed
        fields.set(key, [...(fields.get(key) ?? []), value])
      })

      const url = fields.get('url')?.[0]
      if (!url || !URL_PATTERN.test(url)) return null

      return {
        url,
        name: normalizedName(fields.get('name')?.[0] ?? fields.get('alt')?.[0], url),
        mimeType: normalizedMimeType(fields.get('m')?.[0] ?? fields.get('file-type')?.[0]),
        size: normalizedSize(fields.get('size')?.[0]),
        sha256: fields.get('x')?.[0],
        originalSha256: fields.get('ox')?.[0],
        dim: fields.get('dim')?.[0],
        alt: fields.get('alt')?.[0],
      }
    })
    .filter((attachment): attachment is NestrAttachment => attachment !== null)
}

export function attachmentsFromEvent(event: Pick<NestrEvent, 'tags'>) {
  return attachmentsFromTags(event.tags)
}

export function contentWithAttachmentUrls(content: string, attachments: NestrAttachment[]) {
  const trimmed = content.trim()
  const urls = attachments.map((attachment) => attachment.url).filter((url) => !trimmed.includes(url))
  return [trimmed, ...urls].filter(Boolean).join(trimmed && urls.length > 0 ? '\n' : '')
}

export function contentWithoutAttachmentUrls(content: string, attachments: NestrAttachment[]) {
  let next = content
  attachments.forEach((attachment) => {
    next = next.replaceAll(attachment.url, '')
  })
  return next.replace(/\n{3,}/g, '\n\n').trim()
}

export function nip17FileTags(attachment: NestrAttachment) {
  return [
    ['file-type', attachment.mimeType],
    ['m', attachment.mimeType],
    ['name', attachment.name],
    ['size', String(attachment.size)],
    attachment.encrypted ? ['encryption-algorithm', attachment.encryptionAlgorithm ?? 'aes-gcm'] : null,
    attachment.decryptionKey ? ['decryption-key', attachment.decryptionKey] : null,
    attachment.decryptionNonce ? ['decryption-nonce', attachment.decryptionNonce] : null,
    attachment.sha256 ? ['x', attachment.sha256] : null,
    attachment.originalSha256 ? ['ox', attachment.originalSha256] : null,
    attachment.dim ? ['dim', attachment.dim] : null,
    attachment.alt ? ['alt', attachment.alt] : null,
  ].filter((tag): tag is string[] => Boolean(tag))
}

export function attachmentFromNip17File(content: string, tags: string[][]) {
  const url = content.trim()
  if (!URL_PATTERN.test(url)) return null

  const algorithm = tagValue(tags, 'encryption-algorithm')
  const key = tagValue(tags, 'decryption-key')
  const nonce = tagValue(tags, 'decryption-nonce')
  const encrypted = algorithm === 'aes-gcm' && Boolean(key && nonce)

  return {
    url,
    name: normalizedName(tagValue(tags, 'name') ?? tagValue(tags, 'alt'), url),
    mimeType: normalizedMimeType(tagValue(tags, 'file-type') ?? tagValue(tags, 'm')),
    size: normalizedSize(tagValue(tags, 'size')),
    sha256: tagValue(tags, 'x'),
    originalSha256: tagValue(tags, 'ox'),
    dim: tagValue(tags, 'dim'),
    alt: tagValue(tags, 'alt'),
    encrypted,
    encryptionAlgorithm: encrypted ? 'aes-gcm' : undefined,
    decryptionKey: encrypted ? key : undefined,
    decryptionNonce: encrypted ? nonce : undefined,
  } satisfies NestrAttachment
}

export function attachmentLabel(attachments: NestrAttachment[]) {
  if (attachments.length === 0) return ''
  if (attachments.length === 1) return attachments[0].name
  return `${attachments.length} files`
}

export function attachmentUrls(attachments: NestrAttachment[]) {
  return unique(attachments.map((attachment) => attachment.url))
}
