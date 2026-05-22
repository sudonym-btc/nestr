import { describe, expect, it } from 'vitest'
import { profileNameFromContent, roleLabelFromState } from './liveRelay'

describe('live NIP-29 helpers', () => {
  it('uses profile display names when profile metadata is available', () => {
    expect(profileNameFromContent(JSON.stringify({ display_name: 'Ben Arc', name: 'ben' }))).toBe(
      'Ben Arc',
    )
    expect(profileNameFromContent('{')).toBeNull()
  })

  it('labels NIP-29 roles from relay state clearly', () => {
    expect(roleLabelFromState(['bishop'], true)).toBe('admin: bishop')
    expect(roleLabelFromState([], true)).toBe('member')
    expect(roleLabelFromState([], false, true)).toBe('signed in')
    expect(roleLabelFromState([], false)).toBe('participant')
  })
})
