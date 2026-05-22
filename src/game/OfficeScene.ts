import Phaser from 'phaser'
import { avatarFromPubkey } from '../lib/avatar'
import type { MockUser } from '../lib/mockRelay'
import type { OfficeMap, WorldPosition } from '../lib/world'

export interface OfficeSceneSnapshot {
  map: OfficeMap
  users: MockUser[]
  positions: WorldPosition[]
  selfPubkey: string
}

export type MoveHandler = (position: Pick<WorldPosition, 'x' | 'y' | 'vx' | 'vy'>) => void

interface AvatarNode {
  container: Phaser.GameObjects.Container
  label: Phaser.GameObjects.Text
  pictureUrl?: string
  tween?: Phaser.Tweens.Tween
}

function color(hex: string) {
  return Phaser.Display.Color.HexStringToColor(hex).color
}

function hashInt(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function toneColor(tone: number) {
  if (tone === 0) return 0xdbe7f0
  if (tone === 1) return 0xe6ddf3
  if (tone === 2) return 0xd8ebd8
  return 0xf2ddbd
}

export class OfficeScene extends Phaser.Scene {
  private snapshot?: OfficeSceneSnapshot
  private onMove?: MoveHandler
  private floor?: Phaser.GameObjects.Graphics
  private roomLabels: Phaser.GameObjects.Text[] = []
  private avatars = new Map<string, AvatarNode>()
  private keys?: Record<string, Phaser.Input.Keyboard.Key>
  private target?: Phaser.Math.Vector2
  private loadingProfileTextures = new Set<string>()
  private lastEmit = 0
  private lastViewportKey = ''

  constructor(onMove?: MoveHandler) {
    super('OfficeScene')
    this.onMove = onMove
  }

  setMoveHandler(onMove: MoveHandler) {
    this.onMove = onMove
  }

  applySnapshot(snapshot: OfficeSceneSnapshot) {
    this.snapshot = snapshot
    if (!this.sys?.isActive()) return
    this.redrawViewport(true)
    this.syncAvatars()
  }

  create() {
    this.floor = this.add.graphics()
    this.floor.setDepth(-10000)
    this.keys = this.input.keyboard?.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT') as Record<
      string,
      Phaser.Input.Keyboard.Key
    >

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const camera = this.cameras.main
      this.target = new Phaser.Math.Vector2(pointer.x + camera.scrollX, pointer.y + camera.scrollY)
    })

    if (this.snapshot) {
      this.redrawViewport(true)
      this.syncAvatars()
    }
  }

  update(time: number, delta: number) {
    if (!this.snapshot) return
    this.redrawViewport()

    const selfPosition = this.snapshot.positions.find(
      (position) => position.pubkey === this.snapshot?.selfPubkey,
    )
    const selfAvatar = this.avatars.get(this.snapshot.selfPubkey)
    if (!selfPosition || !selfAvatar) return

    const speed = 0.17 * delta
    let vx = 0
    let vy = 0

    if (this.keys) {
      vx += this.keys.D.isDown || this.keys.RIGHT.isDown ? 1 : 0
      vx -= this.keys.A.isDown || this.keys.LEFT.isDown ? 1 : 0
      vy += this.keys.S.isDown || this.keys.DOWN.isDown ? 1 : 0
      vy -= this.keys.W.isDown || this.keys.UP.isDown ? 1 : 0
    }

    if (vx !== 0 || vy !== 0) {
      this.target = undefined
      const length = Math.hypot(vx, vy)
      vx /= length
      vy /= length
    } else if (this.target) {
      const dx = this.target.x - selfPosition.x
      const dy = this.target.y - selfPosition.y
      const distance = Math.hypot(dx, dy)
      if (distance > 4) {
        vx = dx / distance
        vy = dy / distance
      } else {
        this.target = undefined
      }
    }

    if (vx === 0 && vy === 0) return

    const nextX = selfPosition.x + vx * speed
    const nextY = selfPosition.y + vy * speed

    selfPosition.x = nextX
    selfPosition.y = nextY
    selfPosition.vx = vx
    selfPosition.vy = vy
    selfPosition.updatedAt = Date.now()
    selfAvatar.container.setPosition(nextX, nextY)
    selfAvatar.container.setDepth(nextY)

    if (time - this.lastEmit > 90) {
      this.lastEmit = time
      this.onMove?.({ x: nextX, y: nextY, vx, vy })
    }
  }

  private redrawViewport(force = false) {
    if (!this.snapshot || !this.floor) return
    const { map } = this.snapshot
    const camera = this.cameras.main
    const tile = map.tileSize
    const margin = 180
    const left = camera.scrollX - margin
    const top = camera.scrollY - margin
    const right = camera.scrollX + camera.width + margin
    const bottom = camera.scrollY + camera.height + margin
    const key = [
      Math.floor(left / 96),
      Math.floor(top / 96),
      Math.ceil(right / 96),
      Math.ceil(bottom / 96),
      map.seed.slice(0, 8),
    ].join(':')

    if (!force && key === this.lastViewportKey) return
    this.lastViewportKey = key
    this.floor.clear()
    this.roomLabels.forEach((label) => label.destroy())
    this.roomLabels = []

    this.floor.fillStyle(0xf2e7d2, 1)
    this.floor.fillRect(left, top, right - left, bottom - top)

    const startTileX = Math.floor(left / tile) - 1
    const endTileX = Math.ceil(right / tile) + 1
    const startTileY = Math.floor(top / tile) - 1
    const endTileY = Math.ceil(bottom / tile) + 1

    for (let y = startTileY; y <= endTileY; y += 1) {
      for (let x = startTileX; x <= endTileX; x += 1) {
        const shade = (x + y) % 2 === 0 ? 0xf4e9d5 : 0xeadcc3
        const worldX = x * tile
        const worldY = y * tile
        this.floor.fillStyle(shade, 1)
        this.floor.fillRect(worldX, worldY, tile, tile)
        this.floor.lineStyle(1, 0xffffff, 0.17)
        this.floor.lineBetween(worldX, worldY, worldX + tile, worldY)
        this.floor.lineStyle(1, 0xbda989, 0.08)
        this.floor.lineBetween(worldX + tile, worldY, worldX + tile, worldY + tile)
      }
    }

    this.drawVisibleRooms(left, top, right, bottom)
  }

  private drawVisibleRooms(left: number, top: number, right: number, bottom: number) {
    if (!this.snapshot || !this.floor) return
    const chunk = 520
    const startX = Math.floor(left / chunk) - 1
    const endX = Math.ceil(right / chunk) + 1
    const startY = Math.floor(top / chunk) - 1
    const endY = Math.ceil(bottom / chunk) + 1
    const labels = ['Product', 'Studio', 'Garden', 'Lounge', 'Focus', 'Ops']

    for (let cy = startY; cy <= endY; cy += 1) {
      for (let cx = startX; cx <= endX; cx += 1) {
        const seed = hashInt(`${this.snapshot.map.seed}:${cx}:${cy}`)
        if (seed % 5 === 0 && !(cx === 0 && cy === 0)) continue
        const tone = seed % 4
        const roomWidth = 260 + (seed % 190)
        const roomHeight = 150 + ((seed >> 4) % 120)
        const roomX = cx * chunk + 50 + ((seed >> 8) % Math.max(24, chunk - roomWidth - 70))
        const roomY = cy * chunk + 48 + ((seed >> 16) % Math.max(24, chunk - roomHeight - 72))
        const label = labels[seed % labels.length]

        this.drawRaisedRoom(roomX, roomY, roomWidth, roomHeight, toneColor(tone), label)
        this.drawRoomFurniture(roomX, roomY, roomWidth, roomHeight, seed)
      }
    }
  }

  private drawRaisedRoom(x: number, y: number, width: number, height: number, fill: number, label: string) {
    if (!this.floor) return
    this.floor.fillStyle(0x806d51, 0.13)
    this.floor.fillRoundedRect(x + 10, y + 16, width, height, 12)
    this.floor.fillStyle(fill, 0.8)
    this.floor.fillRoundedRect(x, y, width, height, 12)
    this.floor.lineStyle(2, 0xffffff, 0.68)
    this.floor.strokeRoundedRect(x + 3, y + 3, width - 6, height - 6, 10)
    this.floor.lineStyle(3, 0xbaa98c, 0.18)
    this.floor.lineBetween(x + 10, y + height - 5, x + width - 10, y + height - 5)

    const text = this.add
      .text(x + 16, y + 14, label, {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: '13px',
        color: '#687066',
        backgroundColor: 'rgba(255,255,255,0.58)',
        padding: { x: 8, y: 4 },
      })
      .setDepth(-9000)
    this.roomLabels.push(text)
  }

  private drawRoomFurniture(x: number, y: number, width: number, height: number, seed: number) {
    const count = 4 + (seed % 5)
    for (let index = 0; index < count; index += 1) {
      const itemSeed = hashInt(`${seed}:${index}`)
      const itemX = x + 44 + (itemSeed % Math.max(32, width - 120))
      const itemY = y + 54 + ((itemSeed >> 8) % Math.max(28, height - 94))
      const kind = itemSeed % 5
      if (kind === 0) {
        this.drawPlant(itemX, itemY)
      } else if (kind === 1) {
        this.drawCuboid(itemX, itemY, 92, 24, 0xe7a969, 0xc6844b)
      } else if (kind === 2) {
        this.drawCuboid(itemX, itemY, 54, 42, 0x66758a, 0x43546c)
      } else {
        this.drawCuboid(itemX, itemY, 58, 22, 0xfffcf4, 0xd4c9b7)
      }
    }
  }

  private drawCuboid(x: number, y: number, width: number, height: number, top: number, front: number) {
    if (!this.floor) return
    this.floor.fillStyle(0x000000, 0.1)
    this.floor.fillRoundedRect(x + 6, y + 10, width, height + 10, 5)
    this.floor.fillStyle(front, 1)
    this.floor.fillRoundedRect(x, y + 12, width, height, 5)
    this.floor.fillStyle(top, 1)
    this.floor.fillRoundedRect(x, y, width, height, 5)
    this.floor.lineStyle(1, 0xffffff, 0.6)
    this.floor.lineBetween(x + 5, y + 4, x + width - 7, y + 4)
    this.floor.lineStyle(1, 0x8f7e65, 0.2)
    this.floor.strokeRoundedRect(x, y, width, height + 12, 5)
  }

  private drawPlant(x: number, y: number) {
    if (!this.floor) return
    this.floor.fillStyle(0x2b6b55, 0.95)
    this.floor.fillCircle(x + 12, y + 8, 12)
    this.floor.fillCircle(x + 26, y + 13, 11)
    this.floor.fillCircle(x + 18, y + 24, 10)
    this.floor.fillStyle(0xd7974d, 1)
    this.floor.fillRoundedRect(x + 10, y + 25, 24, 12, 3)
  }

  private syncAvatars() {
    if (!this.snapshot) return

    const usersByPubkey = new Map(this.snapshot.users.map((user) => [user.pubkey, user]))
    const active = new Set(this.snapshot.positions.map((position) => position.pubkey))

    this.avatars.forEach((node, pubkey) => {
      if (!active.has(pubkey)) {
        node.container.destroy()
        this.avatars.delete(pubkey)
      }
    })

    this.snapshot.positions.forEach((position) => {
      const user = usersByPubkey.get(position.pubkey)
      if (!user) return
      const existing = this.avatars.get(position.pubkey)

      if (existing) {
        if (existing.pictureUrl !== user.pictureUrl) {
          existing.container.destroy()
          this.avatars.delete(position.pubkey)
          const node = this.createAvatar(position, user)
          this.avatars.set(position.pubkey, node)
          if (position.pubkey === this.snapshot?.selfPubkey) {
            this.cameras.main.startFollow(node.container, true, 0.1, 0.1)
          }
          return
        }

        if (position.pubkey === this.snapshot?.selfPubkey) {
          existing.tween?.stop()
          existing.container.setPosition(position.x, position.y)
          existing.container.setDepth(position.y)
        } else {
          const jump = Phaser.Math.Distance.Between(
            existing.container.x,
            existing.container.y,
            position.x,
            position.y,
          )
          existing.tween?.stop()
          if (jump > 520) {
            existing.container.setPosition(position.x, position.y)
            existing.container.setDepth(position.y)
          } else {
            existing.tween = this.tweens.add({
              targets: existing.container,
              x: position.x,
              y: position.y,
              duration: 760,
              ease: 'Sine.easeInOut',
              onUpdate: () => existing.container.setDepth(existing.container.y),
            })
          }
        }
        existing.label.setText(user.pubkey === this.snapshot?.selfPubkey ? 'You' : user.name)
        return
      }

      const node = this.createAvatar(position, user)
      this.avatars.set(position.pubkey, node)

      if (position.pubkey === this.snapshot?.selfPubkey) {
        this.cameras.main.startFollow(node.container, true, 0.1, 0.1)
      }
    })
  }

  private createAvatar(position: WorldPosition, user: MockUser): AvatarNode {
    const avatar = avatarFromPubkey(position.pubkey)
    const isSelf = position.pubkey === this.snapshot?.selfPubkey
    const profileTexture = user.pictureUrl ? this.ensureProfileTexture(position.pubkey, user.pictureUrl) : undefined
    const hasProfileTexture = profileTexture ? this.textures.exists(profileTexture) : false
    const shadow = this.add.ellipse(0, 12, 26, 10, 0x000000, 0.15)
    const body = this.add.circle(0, 5, 13, color(avatar.body), 1)
    const trim = this.add.circle(0, 5, 8, color(avatar.trim), 0.9)
    const profileParts: Phaser.GameObjects.GameObject[] = [body, trim]

    if (hasProfileTexture && profileTexture) {
      const portraitRing = this.add.circle(0, -12, 16, 0xffffff, 1)
      const portrait = this.add.image(0, -12, profileTexture).setDisplaySize(27, 27)
      profileParts.push(portraitRing, portrait)
    } else {
      const head = this.add.circle(0, -13, 10, color(avatar.skin), 1)
      const hair = this.add.rectangle(0, -22, 18, 7, color(avatar.hair), 1)
      const badge = this.add
        .text(0, 5, avatar.badge, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '7px',
          color: avatar.body === '#2454d6' ? '#ffffff' : '#171922',
        })
        .setOrigin(0.5)
      profileParts.push(head, hair, badge)
    }

    const label = this.add
      .text(0, -39, isSelf ? 'You' : user.name, {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: '12px',
        color: '#171922',
        backgroundColor: isSelf ? '#dceee2' : '#fffdf8',
        padding: { x: 7, y: 4 },
      })
      .setOrigin(0.5)

    const container = this.add.container(position.x, position.y, [shadow, ...profileParts, label])
    container.setDepth(position.y)
    return { container, label, pictureUrl: hasProfileTexture ? user.pictureUrl : undefined }
  }

  private ensureProfileTexture(pubkey: string, pictureUrl: string) {
    const key = `profile-${pubkey.slice(0, 12)}-${hashInt(pictureUrl)}`
    if (this.textures.exists(key) || this.loadingProfileTextures.has(key)) return key

    this.loadingProfileTextures.add(key)
    this.load.image(key, pictureUrl)
    this.load.once(`filecomplete-image-${key}`, () => {
      this.loadingProfileTextures.delete(key)
      this.syncAvatars()
    })
    this.load.once('loaderror', () => {
      this.loadingProfileTextures.delete(key)
    })
    this.load.start()
    return key
  }
}
