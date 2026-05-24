import { describe, expect, it } from 'vitest'
import {
  createPositionPayload,
  facingFromVelocity,
  parsePositionPayload,
  POSITION_STALE_TIMEOUT_MS,
  positionEventTime,
  resolvePositionPayload,
  shouldApplyPositionUpdate,
  isPositionFresh,
} from './positionEvents'

describe('office position events', () => {
  it('parses replaceable trajectory payloads with millisecond clocks', () => {
    const payload = parsePositionPayload(
      createPositionPayload({ startX: 12, startY: 24, endX: 112, endY: 24, speed: 50 }, 1234),
    )

    expect(payload).toEqual({
      version: 2,
      startX: 12,
      startY: 24,
      endX: 112,
      endY: 24,
      speed: 50,
      sentAt: 1234,
    })
    expect(positionEventTime({ created_at: 1 }, payload)).toBe(1234)
  })

  it('resolves current position and motion from a trajectory', () => {
    const payload = parsePositionPayload(
      createPositionPayload({ startX: 0, startY: 0, endX: 100, endY: 0, speed: 50 }, 1000),
    )

    expect(resolvePositionPayload(payload, 2000)).toMatchObject({
      x: 50,
      y: 0,
      vx: 1,
      vy: 0,
      facing: 'east',
      moving: true,
    })
    expect(resolvePositionPayload(payload, 3000)).toMatchObject({
      x: 100,
      y: 0,
      vx: 0,
      vy: 0,
      moving: false,
    })
    expect(facingFromVelocity(0, -1)).toBe('north')
  })

  it('rejects old position payloads', () => {
    expect(() => parsePositionPayload(JSON.stringify({ x: 12, y: 24, vx: 1, vy: 0 }))).toThrow(
      /unsupported position payload version/,
    )
  })

  it('marks positions stale after the configured timeout', () => {
    expect(isPositionFresh({ updatedAt: 1000 }, 1000 + POSITION_STALE_TIMEOUT_MS)).toBe(true)
    expect(isPositionFresh({ updatedAt: 1000 }, 1001 + POSITION_STALE_TIMEOUT_MS)).toBe(false)
  })

  it('ignores stale self echoes while accepting newer local movement', () => {
    const current = { eventTime: 2000, eventId: 'newer' }

    expect(shouldApplyPositionUpdate(current, { eventTime: 1500, isSelf: true })).toBe(false)
    expect(
      shouldApplyPositionUpdate(current, {
        eventTime: 2000,
        eventId: 'newer',
        isSelf: true,
      }),
    ).toBe(false)
    expect(
      shouldApplyPositionUpdate(current, {
        eventTime: 2200,
        eventId: 'fresh-session',
        isSelf: true,
      }),
    ).toBe(true)
  })
})
