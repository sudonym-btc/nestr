import { describe, expect, it } from 'vitest'
import {
  attachmentFromNip17File,
  attachmentTags,
  attachmentsFromTags,
  contentWithAttachmentUrls,
  contentWithoutAttachmentUrls,
  nip17FileTags,
} from './attachments'
import type { NestrAttachment } from './nostr'

const attachment: NestrAttachment = {
  url: 'https://cdn.example/file.png',
  name: 'file.png',
  mimeType: 'image/png',
  size: 1234,
  sha256: 'a'.repeat(64),
  originalSha256: 'b'.repeat(64),
}

describe('nostr attachments', () => {
  it('serializes group attachments as imeta tags', () => {
    const tags = attachmentTags([attachment])
    expect(tags[0]).toContain('url https://cdn.example/file.png')
    expect(tags[0]).toContain('m image/png')
    expect(attachmentsFromTags(tags)[0]).toMatchObject(attachment)
  })

  it('keeps attachment URLs in content while hiding them for rich rendering', () => {
    const content = contentWithAttachmentUrls('see this', [attachment])
    expect(content).toBe('see this\nhttps://cdn.example/file.png')
    expect(contentWithoutAttachmentUrls(content, [attachment])).toBe('see this')
  })

  it('parses NIP-17 file message metadata', () => {
    const encryptedAttachment = {
      ...attachment,
      encrypted: true,
      encryptionAlgorithm: 'aes-gcm' as const,
      decryptionKey: 'c'.repeat(64),
      decryptionNonce: 'd'.repeat(24),
    }
    const tags = nip17FileTags(encryptedAttachment)

    expect(attachmentFromNip17File(attachment.url, tags)).toMatchObject(encryptedAttachment)
  })
})
