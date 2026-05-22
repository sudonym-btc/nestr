import type { WorldPosition } from './world'

export interface NearbyPeer {
  pubkey: string
  distance: number
}

export interface MeshEstimate {
  participants: number
  connections: number
  perUserConnections: number
  estimatedUploadMbps: number
}

export function nearbyPeers(
  selfPubkey: string,
  positions: WorldPosition[],
  radius = 132,
): NearbyPeer[] {
  const self = positions.find((position) => position.pubkey === selfPubkey)
  if (!self) return []

  return positions
    .filter((position) => position.pubkey !== selfPubkey)
    .map((position) => ({
      pubkey: position.pubkey,
      distance: Math.hypot(position.x - self.x, position.y - self.y),
    }))
    .filter((peer) => peer.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
}

export function estimateWebRtcMesh(participants: number, streamMbps = 1.2): MeshEstimate {
  const safeParticipants = Math.max(1, participants)
  const perUserConnections = safeParticipants - 1

  return {
    participants: safeParticipants,
    connections: (safeParticipants * (safeParticipants - 1)) / 2,
    perUserConnections,
    estimatedUploadMbps: Number((perUserConnections * streamMbps).toFixed(1)),
  }
}

export function meshHealth(participants: number) {
  if (participants <= 3) return 'crisp'
  if (participants <= 5) return 'warm'
  if (participants <= 7) return 'thin'
  return 'stage'
}
