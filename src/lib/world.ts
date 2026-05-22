import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()

export interface OfficeZone {
  id: string
  label: string
  x: number
  y: number
  width: number
  height: number
  tone: 'work' | 'lounge' | 'garden' | 'meeting'
}

export interface OfficeFurniture {
  id: string
  kind: 'desk' | 'plant' | 'sofa' | 'screen' | 'pod'
  x: number
  y: number
  width: number
  height: number
}

export interface OfficeMap {
  groupId: string
  seed: string
  infinite: boolean
  cols: number
  rows: number
  tileSize: number
  zones: OfficeZone[]
  furniture: OfficeFurniture[]
}

export interface WorldPosition {
  pubkey: string
  x: number
  y: number
  vx: number
  vy: number
  facing: 'north' | 'south' | 'east' | 'west'
  updatedAt: number
  eventTime?: number
  eventId?: string
  sequence?: number
}

function hashSeed(value: string) {
  return bytesToHex(sha256(encoder.encode(value)))
}

function numberFromHex(hex: string, start: number) {
  return Number.parseInt(hex.slice(start, start + 8), 16)
}

export function buildOfficeMap(groupId: string, activeUsers: number): OfficeMap {
  void activeUsers
  const seed = hashSeed(`nostr-office-v1:${groupId}`)
  const cols = 48
  const rows = 36
  const tileSize = 32

  const zones: OfficeZone[] = [
    {
      id: 'product',
      label: 'Product',
      x: 3,
      y: 3,
      width: Math.floor(cols * 0.42),
      height: Math.floor(rows * 0.34),
      tone: 'work',
    },
    {
      id: 'studio',
      label: 'Studio',
      x: Math.floor(cols * 0.53),
      y: 3,
      width: Math.floor(cols * 0.36),
      height: Math.floor(rows * 0.28),
      tone: 'meeting',
    },
    {
      id: 'lounge',
      label: 'Lounge',
      x: 4,
      y: Math.floor(rows * 0.58),
      width: Math.floor(cols * 0.36),
      height: Math.floor(rows * 0.28),
      tone: 'lounge',
    },
    {
      id: 'garden',
      label: 'Garden',
      x: Math.floor(cols * 0.58),
      y: Math.floor(rows * 0.58),
      width: Math.floor(cols * 0.31),
      height: Math.floor(rows * 0.28),
      tone: 'garden',
    },
  ]

  const furniture: OfficeFurniture[] = []
  zones.forEach((zone, zoneIndex) => {
    const count = zone.tone === 'garden' ? 7 : zone.tone === 'lounge' ? 5 : 9
    for (let index = 0; index < count; index += 1) {
      const hashed = numberFromHex(seed, (zoneIndex * 8 + index * 3) % 48)
      const x = zone.x + 2 + (hashed % Math.max(1, zone.width - 5))
      const y = zone.y + 2 + (Math.floor(hashed / 7) % Math.max(1, zone.height - 5))
      const kind =
        zone.tone === 'garden'
          ? 'plant'
          : zone.tone === 'lounge'
            ? index % 2 === 0
              ? 'sofa'
              : 'screen'
            : index % 4 === 0
              ? 'pod'
              : 'desk'

      furniture.push({
        id: `${zone.id}-${index}`,
        kind,
        x,
        y,
        width: kind === 'desk' ? 2 : kind === 'sofa' ? 3 : 1,
        height: kind === 'screen' ? 2 : 1,
      })
    }
  })

  return { groupId, seed, infinite: true, cols, rows, tileSize, zones, furniture }
}

export function spawnForPubkey(map: OfficeMap, pubkey: string, index = 0) {
  const hashed = hashSeed(`${map.seed}:${pubkey}:${index}`)
  const zone = map.zones[numberFromHex(hashed, 0) % map.zones.length]
  const tileX = zone.x + 2 + (numberFromHex(hashed, 8) % Math.max(1, zone.width - 4))
  const tileY = zone.y + 2 + (numberFromHex(hashed, 16) % Math.max(1, zone.height - 4))

  return {
    x: tileX * map.tileSize + map.tileSize / 2,
    y: tileY * map.tileSize + map.tileSize / 2,
  }
}

export function mapCapacityLabel(activeUsers: number) {
  return `${activeUsers} in infinite`
}
