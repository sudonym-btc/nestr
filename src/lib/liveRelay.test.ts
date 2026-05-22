import { describe, expect, it } from 'vitest'
import {
  blossomServersFromTags,
  buildProfilePictureCandidates,
  extractBlossomPointer,
  profileNameFromContent,
  profilePictureFromContent,
} from './profileImages'
import { roleLabelFromState } from './liveRelay'

describe('live NIP-29 helpers', () => {
  it('uses profile display names when profile metadata is available', () => {
    expect(profileNameFromContent(JSON.stringify({ display_name: 'Ben Arc', name: 'ben' }))).toBe(
      'Ben Arc',
    )
    expect(profileNameFromContent('{')).toBeNull()
  })

  it('extracts profile picture URLs from kind 0 metadata', () => {
    expect(profilePictureFromContent(JSON.stringify({ picture: 'https://example.com/me.png' }))).toBe(
      'https://example.com/me.png',
    )
    expect(profilePictureFromContent('{}')).toBeNull()
  })

  it('builds Blossom picture candidates from Blossom URIs and server lists', () => {
    const hash = 'a'.repeat(64)
    const pointer = extractBlossomPointer(`blossom:${hash}.jpg?xs=https%3A%2F%2Fmedia.example`, 'b'.repeat(64))

    expect(pointer?.hash).toBe(hash)
    expect(blossomServersFromTags([['server', 'https://cdn.example/']])).toEqual(['https://cdn.example'])
    expect(
      buildProfilePictureCandidates(`blossom:${hash}.jpg`, 'b'.repeat(64), ['https://cdn.example/']),
    ).toContain(`https://cdn.example/${hash}.jpg`)
  })

  it('labels NIP-29 roles from relay state clearly', () => {
    expect(roleLabelFromState(['bishop'], true)).toBe('admin: bishop')
    expect(roleLabelFromState([], true)).toBe('member')
    expect(roleLabelFromState([], false, true)).toBe('signed in')
    expect(roleLabelFromState([], false)).toBe('participant')
  })
})
