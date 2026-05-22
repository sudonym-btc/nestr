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
}

function color(hex: string) {
  return Phaser.Display.Color.HexStringToColor(hex).color
}

export class OfficeScene extends Phaser.Scene {
  private snapshot?: OfficeSceneSnapshot
  private onMove?: MoveHandler
  private floor?: Phaser.GameObjects.Graphics
  private avatars = new Map<string, AvatarNode>()
  private keys?: Record<string, Phaser.Input.Keyboard.Key>
  private target?: Phaser.Math.Vector2
  private lastEmit = 0
  private lastMapSeed = ''

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
    this.redrawMap()
    this.syncAvatars()
  }

  create() {
    this.keys = this.input.keyboard?.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT') as Record<
      string,
      Phaser.Input.Keyboard.Key
    >

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const camera = this.cameras.main
      this.target = new Phaser.Math.Vector2(pointer.x + camera.scrollX, pointer.y + camera.scrollY)
    })

    if (this.snapshot) {
      this.redrawMap()
      this.syncAvatars()
    }
  }

  update(time: number, delta: number) {
    if (!this.snapshot) return

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

    const map = this.snapshot.map
    const nextX = Phaser.Math.Clamp(selfPosition.x + vx * speed, 48, map.cols * map.tileSize - 48)
    const nextY = Phaser.Math.Clamp(selfPosition.y + vy * speed, 48, map.rows * map.tileSize - 48)

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

  private redrawMap() {
    if (!this.snapshot || this.lastMapSeed === this.snapshot.map.seed) return
    this.lastMapSeed = this.snapshot.map.seed
    this.floor?.destroy()
    this.floor = this.add.graphics()
    this.floor.clear()

    const { map } = this.snapshot
    const width = map.cols * map.tileSize
    const height = map.rows * map.tileSize
    const tile = map.tileSize

    this.floor.fillStyle(0xf7ecd9, 1)
    this.floor.fillRect(0, 0, width, height)

    for (let y = 0; y < map.rows; y += 1) {
      for (let x = 0; x < map.cols; x += 1) {
        const shade = (x + y) % 2 === 0 ? 0xf7ecd9 : 0xf3e5cf
        this.floor.fillStyle(shade, 1)
        this.floor.fillRect(x * tile, y * tile, tile, tile)
      }
    }

    map.zones.forEach((zone) => {
      const zoneColor =
        zone.tone === 'work'
          ? 0xdfe8f6
          : zone.tone === 'meeting'
            ? 0xe8e1f6
            : zone.tone === 'garden'
              ? 0xdbeedd
              : 0xf4dfc3

      this.floor!.fillStyle(zoneColor, 0.76)
      this.floor!.fillRoundedRect(
        zone.x * tile,
        zone.y * tile,
        zone.width * tile,
        zone.height * tile,
        10,
      )
      this.floor!.lineStyle(2, 0xffffff, 0.65)
      this.floor!.strokeRoundedRect(
        zone.x * tile + 3,
        zone.y * tile + 3,
        zone.width * tile - 6,
        zone.height * tile - 6,
        10,
      )
      this.add
        .text(zone.x * tile + 16, zone.y * tile + 12, zone.label, {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: '14px',
          color: '#6f726d',
          backgroundColor: 'rgba(255,255,255,0.52)',
          padding: { x: 8, y: 4 },
        })
        .setDepth(3)
    })

    map.furniture.forEach((item) => {
      const x = item.x * tile
      const y = item.y * tile
      const itemWidth = item.width * tile - 7
      const itemHeight = item.height * tile - 7

      if (item.kind === 'plant') {
        this.floor!.fillStyle(0x23694f, 0.92)
        this.floor!.fillCircle(x + tile / 2, y + tile / 2, 10)
        this.floor!.fillStyle(0xf1c46b, 1)
        this.floor!.fillRect(x + 12, y + 20, 16, 7)
        return
      }

      const fill =
        item.kind === 'desk'
          ? 0xfaf8f1
          : item.kind === 'sofa'
            ? 0xe6a86f
            : item.kind === 'screen'
              ? 0x51647d
              : 0xcfd7d5

      this.floor!.fillStyle(0x000000, 0.08)
      this.floor!.fillRoundedRect(x + 4, y + 7, itemWidth, itemHeight, 5)
      this.floor!.fillStyle(fill, 1)
      this.floor!.fillRoundedRect(x, y, itemWidth, itemHeight, 5)
      this.floor!.lineStyle(1, 0xd2c5b4, 1)
      this.floor!.strokeRoundedRect(x, y, itemWidth, itemHeight, 5)
    })

    this.cameras.main.setBounds(0, 0, width, height)
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
        existing.container.setPosition(position.x, position.y)
        existing.container.setDepth(position.y)
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
    const shadow = this.add.ellipse(0, 12, 26, 10, 0x000000, 0.15)
    const body = this.add.circle(0, 2, 13, color(avatar.body), 1)
    const trim = this.add.circle(0, 2, 8, color(avatar.trim), 0.9)
    const head = this.add.circle(0, -13, 10, color(avatar.skin), 1)
    const hair = this.add.rectangle(0, -22, 18, 7, color(avatar.hair), 1)
    const badge = this.add
      .text(0, 2, avatar.badge, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '7px',
        color: avatar.body === '#2454d6' ? '#ffffff' : '#171922',
      })
      .setOrigin(0.5)
    const label = this.add
      .text(0, -39, isSelf ? 'You' : user.name, {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: '12px',
        color: '#171922',
        backgroundColor: isSelf ? '#dceee2' : '#fffdf8',
        padding: { x: 7, y: 4 },
      })
      .setOrigin(0.5)

    const container = this.add.container(position.x, position.y, [shadow, body, trim, head, hair, badge, label])
    container.setDepth(position.y)
    return { container, label }
  }
}
