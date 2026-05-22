import { describe, expect, it } from 'vitest'
import { estimateWebRtcMesh, nearbyPeers } from './videoMesh'
import type { WorldPosition } from './world'

const positions: WorldPosition[] = [
  { pubkey: 'a', x: 0, y: 0, vx: 0, vy: 0, facing: 'south', updatedAt: 0 },
  { pubkey: 'b', x: 30, y: 40, vx: 0, vy: 0, facing: 'south', updatedAt: 0 },
  { pubkey: 'c', x: 300, y: 400, vx: 0, vy: 0, facing: 'south', updatedAt: 0 },
]

describe('WebRTC mesh helpers', () => {
  it('finds peers inside a proximity radius', () => {
    expect(nearbyPeers('a', positions, 80)).toEqual([{ pubkey: 'b', distance: 50 }])
  })

  it('estimates full-mesh WebRTC connection pressure', () => {
    expect(estimateWebRtcMesh(5)).toEqual({
      participants: 5,
      connections: 10,
      perUserConnections: 4,
      estimatedUploadMbps: 4.8,
    })
  })
})
