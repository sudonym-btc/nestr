import type { WorldPosition } from './world'

export const PRESENCE_WINDOW_MS = 15 * 60 * 1000

export const ACTIVITY_KINDS = [
  0,
  1,
  3,
  6,
  7,
  9735,
  30023,
]

export function isOnlineFromActivity(
  pubkey: string,
  activityAt: Record<string, number>,
  positions: WorldPosition[],
  now = Date.now(),
) {
  const positionAt = positions.find((position) => position.pubkey === pubkey)?.updatedAt ?? 0
  const relayActivityAt = activityAt[pubkey] ?? 0
  return Math.max(positionAt, relayActivityAt) >= now - PRESENCE_WINDOW_MS
}
