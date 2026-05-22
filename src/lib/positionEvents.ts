import type { NestrEvent } from './nostr'
import type { WorldPosition } from './world'

export type Facing = WorldPosition['facing']

export interface PositionPayload {
  x: number
  y: number
  vx: number
  vy: number
  facing: Facing
  sentAt?: number
  seq?: number
}

export interface IncomingPositionClock {
  eventTime: number
  eventId?: string
  sequence?: number
  isSelf?: boolean
}

const facings = new Set<Facing>(['north', 'south', 'east', 'west'])

function finiteNumber(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid position ${name}`)
  }
  return value
}

function optionalFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function facingFromVelocity(vx: number, vy: number): Facing {
  return Math.abs(vx) > Math.abs(vy) ? (vx >= 0 ? 'east' : 'west') : vy < 0 ? 'north' : 'south'
}

export function parsePositionPayload(content: string): PositionPayload {
  const payload = JSON.parse(content) as Record<string, unknown>
  const x = finiteNumber(payload.x, 'x')
  const y = finiteNumber(payload.y, 'y')
  const vx = finiteNumber(payload.vx, 'vx')
  const vy = finiteNumber(payload.vy, 'vy')
  const facing = facings.has(payload.facing as Facing)
    ? (payload.facing as Facing)
    : facingFromVelocity(vx, vy)

  return {
    x,
    y,
    vx,
    vy,
    facing,
    sentAt: optionalFiniteNumber(payload.sentAt),
    seq: optionalFiniteNumber(payload.seq),
  }
}

export function positionEventTime(
  event: Pick<NestrEvent, 'created_at'>,
  payload: Pick<PositionPayload, 'sentAt'>,
) {
  return payload.sentAt ?? event.created_at * 1000
}

export function shouldApplyPositionUpdate(
  current: Pick<WorldPosition, 'eventTime' | 'eventId' | 'sequence'> | undefined,
  incoming: IncomingPositionClock,
) {
  if (typeof current?.eventTime !== 'number') return true

  if (incoming.eventTime < current.eventTime) return false
  if (incoming.eventTime > current.eventTime) return true
  if (incoming.eventId && incoming.eventId === current.eventId) return false

  if (typeof incoming.sequence === 'number' && typeof current.sequence === 'number') {
    return incoming.sequence > current.sequence
  }

  return !incoming.isSelf
}
