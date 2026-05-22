import { describe, expect, it } from 'vitest'
import {
  facingFromVelocity,
  parsePositionPayload,
  positionEventTime,
  shouldApplyPositionUpdate,
} from './positionEvents'

describe('office position events', () => {
  it('parses signed movement payloads with millisecond clocks', () => {
    const payload = parsePositionPayload(
      JSON.stringify({ x: 12, y: 24, vx: 1, vy: 0, sentAt: 1234, seq: 7 }),
    )

    expect(payload).toEqual({
      x: 12,
      y: 24,
      vx: 1,
      vy: 0,
      facing: 'east',
      sentAt: 1234,
      seq: 7,
    })
    expect(positionEventTime({ created_at: 1 }, payload)).toBe(1234)
  })

  it('falls back to event seconds for older movement events', () => {
    expect(positionEventTime({ created_at: 12 }, { sentAt: undefined })).toBe(12000)
    expect(facingFromVelocity(0, -1)).toBe('north')
  })

  it('ignores stale self echoes while accepting newer local movement', () => {
    const current = { eventTime: 2000, eventId: 'newer', sequence: 4 }

    expect(shouldApplyPositionUpdate(current, { eventTime: 1500, isSelf: true })).toBe(false)
    expect(
      shouldApplyPositionUpdate(current, {
        eventTime: 2000,
        eventId: 'newer',
        sequence: 4,
        isSelf: true,
      }),
    ).toBe(false)
    expect(
      shouldApplyPositionUpdate(current, {
        eventTime: 2000,
        eventId: 'older-at-same-time',
        sequence: 3,
        isSelf: true,
      }),
    ).toBe(false)
    expect(
      shouldApplyPositionUpdate(current, {
        eventTime: 2200,
        eventId: 'fresh-session',
        sequence: 1,
        isSelf: true,
      }),
    ).toBe(true)
  })
})
