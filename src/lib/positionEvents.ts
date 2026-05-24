import type { NestrEvent } from './nostr'
import type { WorldPosition } from './world'

export type Facing = WorldPosition['facing']

export interface PositionMovement {
  startX: number
  startY: number
  endX: number
  endY: number
  speed: number
}

export const POSITION_REBROADCAST_INTERVAL_MS = 5 * 1000
export const POSITION_REBROADCAST_RESIGN_AFTER_MS = 2 * 60 * 1000
export const POSITION_STALE_TIMEOUT_MS = 20 * 1000

export interface PositionPayload extends PositionMovement {
  version: 2
  sentAt: number
}

export interface ResolvedPosition {
  x: number
  y: number
  vx: number
  vy: number
  facing: Facing
  moving: boolean
  arrivesAt: number
}

export interface IncomingPositionClock {
  eventTime: number
  eventId?: string
  isSelf?: boolean
}

const facings = new Set<Facing>(['north', 'south', 'east', 'west'])

function finiteNumber(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid position ${name}`)
  }
  return value
}

function point(value: unknown, name: string) {
  if (!value || typeof value !== 'object') {
    throw new Error(`invalid position ${name}`)
  }
  const candidate = value as Record<string, unknown>
  return {
    x: finiteNumber(candidate.x, `${name}.x`),
    y: finiteNumber(candidate.y, `${name}.y`),
  }
}

export function facingFromVelocity(vx: number, vy: number): Facing {
  if (vx === 0 && vy === 0) return 'south'
  return Math.abs(vx) > Math.abs(vy) ? (vx >= 0 ? 'east' : 'west') : vy < 0 ? 'north' : 'south'
}

export function createPositionPayload(movement: PositionMovement, sentAt: number) {
  return JSON.stringify({
    v: 2,
    sentAt,
    startPos: {
      x: movement.startX,
      y: movement.startY,
    },
    endPos: {
      x: movement.endX,
      y: movement.endY,
    },
    speed: movement.speed,
  })
}

export function parsePositionPayload(content: string): PositionPayload {
  const payload = JSON.parse(content) as Record<string, unknown>
  if (payload.v !== 2) throw new Error('unsupported position payload version')
  const startPos = point(payload.startPos, 'startPos')
  const endPos = point(payload.endPos, 'endPos')
  const speed = finiteNumber(payload.speed, 'speed')
  const sentAt = finiteNumber(payload.sentAt, 'sentAt')
  if (speed < 0) throw new Error('invalid position speed')

  return {
    version: 2,
    startX: startPos.x,
    startY: startPos.y,
    endX: endPos.x,
    endY: endPos.y,
    speed,
    sentAt,
  }
}

export function resolvePositionPayload(payload: PositionPayload, at = Date.now()): ResolvedPosition {
  const dx = payload.endX - payload.startX
  const dy = payload.endY - payload.startY
  const distance = Math.hypot(dx, dy)
  const durationMs = payload.speed > 0 && distance > 0 ? (distance / payload.speed) * 1000 : 0
  const progress = durationMs > 0 ? Math.min(Math.max((at - payload.sentAt) / durationMs, 0), 1) : 1
  const moving = progress < 1
  const vx = moving && distance > 0 ? dx / distance : 0
  const vy = moving && distance > 0 ? dy / distance : 0

  return {
    x: payload.startX + dx * progress,
    y: payload.startY + dy * progress,
    vx,
    vy,
    facing: facingFromVelocity(vx, vy),
    moving,
    arrivesAt: payload.sentAt + durationMs,
  }
}

export function worldPositionFromPayload(
  pubkey: string,
  event: Pick<NestrEvent, 'id' | 'created_at'>,
  payload: PositionPayload,
  at = Date.now(),
): WorldPosition {
  const resolved = resolvePositionPayload(payload, at)
  return {
    pubkey,
    x: resolved.x,
    y: resolved.y,
    vx: resolved.vx,
    vy: resolved.vy,
    facing: resolved.facing,
    updatedAt: at,
    eventTime: positionEventTime(event, payload),
    eventId: event.id,
    startX: payload.startX,
    startY: payload.startY,
    targetX: payload.endX,
    targetY: payload.endY,
    speed: payload.speed,
    sentAt: payload.sentAt,
    arrivesAt: resolved.arrivesAt,
    moving: resolved.moving,
  }
}

export function resolveWorldPosition(position: WorldPosition, at = Date.now()): WorldPosition {
  if (
    typeof position.startX !== 'number' ||
    typeof position.startY !== 'number' ||
    typeof position.targetX !== 'number' ||
    typeof position.targetY !== 'number' ||
    typeof position.speed !== 'number' ||
    typeof position.sentAt !== 'number'
  ) {
    return position
  }

  const payload: PositionPayload = {
    version: 2,
    startX: position.startX,
    startY: position.startY,
    endX: position.targetX,
    endY: position.targetY,
    speed: position.speed,
    sentAt: position.sentAt,
  }
  const resolved = resolvePositionPayload(payload, at)
  return {
    ...position,
    x: resolved.x,
    y: resolved.y,
    vx: resolved.vx,
    vy: resolved.vy,
    facing: resolved.facing,
    moving: resolved.moving,
    arrivesAt: resolved.arrivesAt,
  }
}

export function isPositionFresh(position: Pick<WorldPosition, 'updatedAt'>, at = Date.now()) {
  return at - position.updatedAt <= POSITION_STALE_TIMEOUT_MS
}

export function positionEventTime(
  event: Pick<NestrEvent, 'created_at'>,
  payload: Pick<PositionPayload, 'sentAt'>,
) {
  return payload.sentAt ?? event.created_at * 1000
}

export function shouldApplyPositionUpdate(
  current: Pick<WorldPosition, 'eventTime' | 'eventId'> | undefined,
  incoming: IncomingPositionClock,
) {
  if (typeof current?.eventTime !== 'number') return true

  if (incoming.eventTime < current.eventTime) return false
  if (incoming.eventTime > current.eventTime) return true
  if (incoming.eventId && incoming.eventId === current.eventId) return false

  return !incoming.isSelf
}

export function isFacing(value: unknown): value is Facing {
  return facings.has(value as Facing)
}
