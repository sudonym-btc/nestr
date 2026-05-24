import { describe, expect, it } from 'vitest'
import { buildOfficeMap, spawnAwayFromPositions, spawnForPubkey } from './world'
import { seededPubkey } from './avatar'

describe('office map generation', () => {
  it('is deterministic for a NIP-29 group id', () => {
    expect(buildOfficeMap('product-floor', 10)).toEqual(buildOfficeMap('product-floor', 10))
  })

  it('keeps one infinite world regardless of population', () => {
    const small = buildOfficeMap('product-floor', 10)
    const large = buildOfficeMap('product-floor', 1000)
    expect(small.infinite).toBe(true)
    expect(large.infinite).toBe(true)
    expect(large.cols * large.rows).toBe(small.cols * small.rows)
  })

  it('places a pubkey inside the generated office bounds', () => {
    const map = buildOfficeMap('product-floor', 24)
    const spawn = spawnForPubkey(map, seededPubkey('spawn'), 0)
    expect(spawn.x).toBeGreaterThan(0)
    expect(spawn.y).toBeGreaterThan(0)
    expect(spawn.x).toBeLessThan(map.cols * map.tileSize)
    expect(spawn.y).toBeLessThan(map.rows * map.tileSize)
  })

  it('moves a first spawn outside occupied proximity bubbles', () => {
    const map = buildOfficeMap('product-floor', 24)
    const pubkey = seededPubkey('new-arrival')
    const preferred = spawnForPubkey(map, pubkey, 0)
    const minDistance = map.tileSize * 5

    const spawn = spawnAwayFromPositions(map, pubkey, 0, [preferred], minDistance)

    expect(Math.hypot(spawn.x - preferred.x, spawn.y - preferred.y)).toBeGreaterThanOrEqual(minDistance)
    expect(spawn.x).toBeGreaterThan(0)
    expect(spawn.y).toBeGreaterThan(0)
    expect(spawn.x).toBeLessThan(map.cols * map.tileSize)
    expect(spawn.y).toBeLessThan(map.rows * map.tileSize)
  })
})
