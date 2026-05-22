import { describe, expect, it } from 'vitest'
import { buildOfficeMap, spawnForPubkey } from './world'
import { seededPubkey } from './avatar'

describe('office map generation', () => {
  it('is deterministic for a NIP-29 group id', () => {
    expect(buildOfficeMap('product-floor', 10)).toEqual(buildOfficeMap('product-floor', 10))
  })

  it('scales the world as population grows', () => {
    const small = buildOfficeMap('product-floor', 10)
    const large = buildOfficeMap('product-floor', 1000)
    expect(large.cols * large.rows).toBeGreaterThan(small.cols * small.rows)
  })

  it('places a pubkey inside the generated office bounds', () => {
    const map = buildOfficeMap('product-floor', 24)
    const spawn = spawnForPubkey(map, seededPubkey('spawn'), 0)
    expect(spawn.x).toBeGreaterThan(0)
    expect(spawn.y).toBeGreaterThan(0)
    expect(spawn.x).toBeLessThan(map.cols * map.tileSize)
    expect(spawn.y).toBeLessThan(map.rows * map.tileSize)
  })
})
