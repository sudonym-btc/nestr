import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { avatarFromPubkey, type AvatarStyle } from '../lib/avatar'
import type { PositionMovement } from '../lib/positionEvents'
import type { MockUser } from '../lib/mockRelay'
import type { OfficeMap, WorldPosition } from '../lib/world'

interface OfficeSceneSnapshot {
  map: OfficeMap
  users: MockUser[]
  positions: WorldPosition[]
  selfPubkey: string
}

type MoveHandler = (movement: PositionMovement) => void
type JumpTarget = Pick<WorldPosition, 'x' | 'y'>

interface OfficeRendererProps {
  snapshot: OfficeSceneSnapshot
  onMove: MoveHandler
  canPlaceSelf?: boolean
}

type OfficeTone = 'work' | 'lounge' | 'garden' | 'meeting'
type AssetKey =
  | 'adjustableDesk'
  | 'bookStack'
  | 'chair'
  | 'coffeeTable'
  | 'computer'
  | 'computerScreen'
  | 'couchMedium'
  | 'couchSmall'
  | 'couchWide'
  | 'desk'
  | 'dualMonitors'
  | 'fileCabinet'
  | 'houseplant'
  | 'lamp'
  | 'monitor'
  | 'officeChair'
  | 'plantWhitePot'
  | 'pottedPlant'
  | 'roundRug'
  | 'rug'
  | 'shelf'
  | 'standingDesk'
  | 'table'
  | 'tableRound'
  | 'waterCooler'
  | 'whiteboard'

interface AssetSpec {
  key: AssetKey
  file: string
  footprint: readonly [number, number]
  maxHeight: number
  fallback: 'box' | 'chair' | 'plant' | 'sofa' | 'table' | 'screen' | 'rug'
  color: number
}

interface LoadedAsset {
  scene?: THREE.Group
  loading?: Promise<THREE.Group>
  failed?: boolean
}

interface AvatarNode {
  group: THREE.Group
  body: THREE.Mesh
  label: THREE.Sprite
  leftArm: THREE.Group
  rightArm: THREE.Group
  leftLeg: THREE.Group
  rightLeg: THREE.Group
  current: THREE.Vector2
  target: THREE.Vector2
  labelText: string
  labelAvatarKey: string
  walkingUntil: number
  lastSnapshotAt: number
  trajectory?: AvatarTrajectory
}

interface AvatarTrajectory {
  start: THREE.Vector2
  end: THREE.Vector2
  speed: number
  sentAt: number
}

interface LabelAvatarOptions {
  fallback: AvatarStyle
  image?: HTMLImageElement
}

interface RoomPlan {
  id: string
  label: string
  tone: OfficeTone
  x: number
  z: number
  width: number
  depth: number
  rotation: number
  seed: string
}

interface AssetPlacementOptions {
  y?: number
  scale?: number
  tint?: number
}

interface CameraDragState {
  pointerId: number
  button: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  dragging: boolean
}

const WORLD_SCALE = 0.045
const CHUNK_SIZE = 24
const KEYBOARD_SPEED = 178
const CLICK_SPEED = KEYBOARD_SPEED * 2
const ARRIVAL_RADIUS = 0.24
const KEYBOARD_INTENT_HORIZON_MS = 10_000
const KEYBOARD_REPUBLISH_MS = 5_000
const ROOM_RANGE = 2
const ROOM_BUFFER_RANGE = ROOM_RANGE
const WORLD_REBUILD_HYSTERESIS_CHUNKS = 1
const SELF_ECHO_HOLD_MS = 900
const AVATAR_APPROACH_DISTANCE = 2.45
const MODEL_ROOT = `${import.meta.env.BASE_URL}assets/office-pack/models/`
const CAMERA_VIEW_HEIGHT = 23
const MAX_CAMERA_VIEW_SCALE = 2.7
const CAMERA_DRAG_THRESHOLD = 4
const CAMERA_ZOOM_RESET_MS = 280
const MAX_RENDER_PIXEL_RATIO = 1.5

const assetCache = new Map<AssetKey, LoadedAsset>()
const loader = new GLTFLoader()
const profileImageCache = new Map<string, HTMLImageElement | 'failed' | Promise<HTMLImageElement | null>>()

const OFFICE_ASSETS = {
  adjustableDesk: asset('adjustableDesk', 'adjustable-desk.glb', [2.1, 1.15], 1.15, 'table', 0xc58f58),
  bookStack: asset('bookStack', 'book-stack.glb', [0.45, 0.45], 0.32, 'box', 0xd8b56e),
  chair: asset('chair', 'chair.glb', [0.82, 0.82], 1.0, 'chair', 0x8ba283),
  coffeeTable: asset('coffeeTable', 'coffee-table.glb', [1.75, 1.0], 0.52, 'table', 0xc99055),
  computer: asset('computer', 'computer.glb', [0.62, 0.48], 0.6, 'screen', 0x627086),
  computerScreen: asset('computerScreen', 'computer-screen.glb', [0.48, 0.18], 0.46, 'screen', 0x516071),
  couchMedium: asset('couchMedium', 'couch-medium.glb', [3.0, 1.35], 1.1, 'sofa', 0x98abb4),
  couchSmall: asset('couchSmall', 'couch-small.glb', [1.75, 1.2], 0.95, 'sofa', 0x9eb79d),
  couchWide: asset('couchWide', 'couch-wide.glb', [2.75, 1.1], 0.82, 'sofa', 0xaec0c8),
  desk: asset('desk', 'desk.glb', [2.25, 1.05], 0.86, 'table', 0xc88e50),
  dualMonitors: asset('dualMonitors', 'dual-monitors-on-sit-stand-arm.glb', [1.05, 0.76], 0.92, 'screen', 0x59687d),
  fileCabinet: asset('fileCabinet', 'file-cabinet.glb', [0.82, 0.72], 1.12, 'box', 0x6f7988),
  houseplant: asset('houseplant', 'houseplant-bfloqiv5up.glb', [0.92, 0.92], 1.2, 'plant', 0x4d7d5f),
  lamp: asset('lamp', 'lamp.glb', [0.55, 0.55], 1.42, 'screen', 0xd6c9a6),
  monitor: asset('monitor', 'monitor.glb', [0.48, 0.22], 0.44, 'screen', 0x576577),
  officeChair: asset('officeChair', 'office-chair.glb', [0.72, 0.74], 1.05, 'chair', 0x62748c),
  plantWhitePot: asset('plantWhitePot', 'plant-white-pot.glb', [1.05, 1.05], 1.95, 'plant', 0x517b61),
  pottedPlant: asset('pottedPlant', 'potted-plant.glb', [0.84, 0.84], 1.36, 'plant', 0x517b61),
  roundRug: asset('roundRug', 'rug-round.glb', [3.6, 3.6], 0.04, 'rug', 0x89a9b6),
  rug: asset('rug', 'rug.glb', [3.5, 2.05], 0.04, 'rug', 0xbcc8d1),
  shelf: asset('shelf', 'medium-book-shelf.glb', [2.0, 0.48], 1.8, 'box', 0x8c7960),
  standingDesk: asset('standingDesk', 'standing-desk.glb', [2.1, 1.2], 1.12, 'table', 0xc89152),
  table: asset('table', 'table.glb', [2.2, 1.12], 0.82, 'table', 0xc89152),
  tableRound: asset('tableRound', 'table-large-circular.glb', [2.5, 2.5], 0.78, 'table', 0xc89152),
  waterCooler: asset('waterCooler', 'water-cooler.glb', [0.74, 0.74], 1.42, 'box', 0x9db4c4),
  whiteboard: asset('whiteboard', 'whiteboard.glb', [2.25, 0.18], 1.45, 'screen', 0xf2f4f3),
} satisfies Record<AssetKey, AssetSpec>

const ASSET_BASE_LIFT: Partial<Record<AssetKey, number>> = {
  houseplant: 0.08,
  plantWhitePot: 0.42,
  pottedPlant: 0.1,
}

const roomMaterials: Record<OfficeTone, THREE.MeshStandardMaterial> = {
  work: new THREE.MeshStandardMaterial({ color: 0xe4e5e1, roughness: 0.88, metalness: 0.01 }),
  lounge: new THREE.MeshStandardMaterial({ color: 0xe7e4dc, roughness: 0.9, metalness: 0.01 }),
  garden: new THREE.MeshStandardMaterial({ color: 0xe1e7dc, roughness: 0.92, metalness: 0.01 }),
  meeting: new THREE.MeshStandardMaterial({ color: 0xe5e3e1, roughness: 0.9, metalness: 0.01 }),
}

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xf8f7f3, roughness: 0.58 })
const glassMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xf7fbff,
  opacity: 0.42,
  transparent: true,
  roughness: 0.16,
  metalness: 0,
})
const ringMaterial = new THREE.MeshBasicMaterial({
  color: 0x9bdd8f,
  opacity: 0.23,
  transparent: true,
  depthWrite: false,
})
const softFloorWashGeometry = new THREE.CircleGeometry(46, 56)
const softFloorWashMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  opacity: 0.055,
  transparent: true,
  depthWrite: false,
})

function asset(
  key: AssetKey,
  file: string,
  footprint: readonly [number, number],
  maxHeight: number,
  fallback: AssetSpec['fallback'],
  color: number,
): AssetSpec {
  return { key, file, footprint, maxHeight, fallback, color }
}

function hashInt(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function randomUnit(seed: string, salt: string) {
  return hashInt(`${seed}:${salt}`) / 0xffffffff
}

function randomBetween(seed: string, salt: string, min: number, max: number) {
  return min + (max - min) * randomUnit(seed, salt)
}

function randomChoice<T>(seed: string, salt: string, values: readonly T[]) {
  return values[hashInt(`${seed}:${salt}`) % values.length]
}

function worldToSceneX(x: number) {
  return x * WORLD_SCALE
}

function worldToSceneZ(y: number) {
  return y * WORLD_SCALE
}

function sceneToWorldX(x: number) {
  return x / WORLD_SCALE
}

function sceneToWorldY(z: number) {
  return z / WORLD_SCALE
}

function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return (object as THREE.Mesh).isMesh
}

function setModelShadows(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!isMesh(child)) return
    child.castShadow = true
    child.receiveShadow = true
  })
}

function cloneObjectMaterials(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!isMesh(child)) return
    child.material = cloneMaterial(child.material)
  })
}

function cloneMaterial(material: THREE.Material | THREE.Material[]) {
  return Array.isArray(material) ? material.map((entry) => entry.clone()) : material.clone()
}

function loadAsset(spec: AssetSpec) {
  const cached = assetCache.get(spec.key)
  if (cached?.scene) return Promise.resolve(cached.scene)
  if (cached?.loading) return cached.loading

  const loading = new Promise<THREE.Group>((resolve, reject) => {
    loader.load(
      `${MODEL_ROOT}${spec.file}`,
      (gltf) => {
        const scene = gltf.scene.clone(true)
        scene.traverse((child) => {
          if (!isMesh(child)) return
          child.material = cloneMaterial(child.material)
          child.castShadow = true
          child.receiveShadow = true
        })
        normalizeObject(scene, spec)
        assetCache.set(spec.key, { scene })
        resolve(scene)
      },
      undefined,
      (error) => {
        assetCache.set(spec.key, { failed: true })
        reject(error)
      },
    )
  })

  assetCache.set(spec.key, { loading })
  return loading
}

function normalizeObject(object: THREE.Object3D, spec: AssetSpec, scaleMultiplier = 1) {
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const scale = Math.min(
    spec.footprint[0] / Math.max(size.x, 0.001),
    spec.footprint[1] / Math.max(size.z, 0.001),
    spec.maxHeight / Math.max(size.y, 0.001),
  )

  object.scale.multiplyScalar(scale * scaleMultiplier)
  const normalized = new THREE.Box3().setFromObject(object)
  const center = normalized.getCenter(new THREE.Vector3())
  object.position.x -= center.x
  object.position.y -= normalized.min.y
  object.position.z -= center.z
}

function roundedRectShape(width: number, depth: number, radius: number) {
  const shape = new THREE.Shape()
  drawRoundedPath(shape, width, depth, radius)
  return shape
}

function roundedRectPath(width: number, depth: number, radius: number) {
  const path = new THREE.Path()
  drawRoundedPath(path, width, depth, radius)
  return path
}

function drawRoundedPath(path: THREE.Path, width: number, depth: number, radius: number) {
  const x = -width / 2
  const y = -depth / 2
  const right = width / 2
  const bottom = depth / 2
  const r = Math.min(radius, width / 2, depth / 2)

  path.moveTo(x + r, y)
  path.lineTo(right - r, y)
  path.quadraticCurveTo(right, y, right, y + r)
  path.lineTo(right, bottom - r)
  path.quadraticCurveTo(right, bottom, right - r, bottom)
  path.lineTo(x + r, bottom)
  path.quadraticCurveTo(x, bottom, x, bottom - r)
  path.lineTo(x, y + r)
  path.quadraticCurveTo(x, y, x + r, y)
  path.closePath()
}

function makeRoundedPlane(width: number, depth: number, radius: number, material: THREE.Material) {
  const geometry = new THREE.ShapeGeometry(roundedRectShape(width, depth, radius), 24)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.rotation.x = -Math.PI / 2
  mesh.receiveShadow = true
  return mesh
}

function makeRoomWall(width: number, depth: number) {
  const group = new THREE.Group()
  const height = 0.72
  const thickness = 0.34
  const outer = roundedRectShape(width + thickness * 1.2, depth + thickness * 1.2, 1.16)
  outer.holes.push(roundedRectPath(width - thickness * 1.18, depth - thickness * 1.18, 0.86))
  const geometry = new THREE.ExtrudeGeometry(outer, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 24,
    steps: 1,
  })
  geometry.rotateX(-Math.PI / 2)
  const ring = new THREE.Mesh(geometry, wallMaterial)
  ring.castShadow = true
  ring.receiveShadow = true
  group.add(ring)

  const glass = makeRoundedPlane(width - 0.86, depth - 0.86, 0.82, glassMaterial)
  glass.position.y = 0.62
  glass.scale.y = 0.94
  glass.visible = false
  group.add(glass)
  return group
}

function drawRoundedCanvasRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + r, y)
  context.lineTo(x + width - r, y)
  context.quadraticCurveTo(x + width, y, x + width, y + r)
  context.lineTo(x + width, y + height - r)
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  context.lineTo(x + r, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - r)
  context.lineTo(x, y + r)
  context.quadraticCurveTo(x, y, x + r, y)
  context.closePath()
}

function drawProfileAvatar(
  context: CanvasRenderingContext2D,
  avatar: AvatarStyle,
  x: number,
  y: number,
  size: number,
) {
  const radius = size / 2
  const centerX = x + radius
  const centerY = y + radius

  context.save()
  context.beginPath()
  context.arc(centerX, centerY, radius, 0, Math.PI * 2)
  context.clip()
  context.fillStyle = avatar.body
  context.fillRect(x, y, size, size)
  context.fillStyle = avatar.trim
  context.fillRect(x, y + size * 0.62, size, size * 0.38)
  context.fillStyle = avatar.skin
  context.beginPath()
  context.arc(centerX, y + size * 0.44, size * 0.24, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = avatar.hair
  context.fillRect(x + size * 0.26, y + size * 0.2, size * 0.48, size * 0.16)
  context.restore()

  context.lineWidth = Math.max(2, size * 0.08)
  context.strokeStyle = 'rgba(255, 255, 255, 0.88)'
  context.beginPath()
  context.arc(centerX, centerY, radius - context.lineWidth / 2, 0, Math.PI * 2)
  context.stroke()
}

function drawProfileImageAvatar(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  size: number,
) {
  const radius = size / 2
  const centerX = x + radius
  const centerY = y + radius
  const imageRatio = image.naturalWidth / Math.max(image.naturalHeight, 1)
  const targetRatio = 1
  const sourceWidth = imageRatio > targetRatio ? image.naturalHeight * targetRatio : image.naturalWidth
  const sourceHeight = imageRatio > targetRatio ? image.naturalHeight : image.naturalWidth / targetRatio
  const sourceX = (image.naturalWidth - sourceWidth) / 2
  const sourceY = (image.naturalHeight - sourceHeight) / 2

  context.save()
  context.beginPath()
  context.arc(centerX, centerY, radius, 0, Math.PI * 2)
  context.clip()
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, size, size)
  context.restore()

  context.lineWidth = Math.max(2, size * 0.08)
  context.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  context.beginPath()
  context.arc(centerX, centerY, radius - context.lineWidth / 2, 0, Math.PI * 2)
  context.stroke()
}

function profileImageKey(candidates: string[] = []) {
  return candidates.join('|')
}

function loadProfileImage(url: string): Promise<HTMLImageElement | null> {
  const cached = profileImageCache.get(url)
  if (cached === 'failed') return Promise.resolve(null)
  if (cached instanceof HTMLImageElement) return Promise.resolve(cached)
  if (cached) return cached

  const loading = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.referrerPolicy = 'no-referrer'
    image.onload = () => {
      profileImageCache.set(url, image)
      resolve(image)
    }
    image.onerror = () => {
      profileImageCache.set(url, 'failed')
      resolve(null)
    }
    image.src = url
  })

  profileImageCache.set(url, loading)
  return loading
}

async function loadFirstProfileImage(candidates: string[] = []) {
  for (const candidate of candidates) {
    const image = await loadProfileImage(candidate)
    if (image) return image
  }
  return undefined
}

function makeTextSprite(
  text: string,
  options: { background?: string; color?: string; fontSize?: number; padding?: number; avatar?: LabelAvatarOptions } = {},
) {
  const fontSize = options.fontSize ?? 30
  const padding = options.padding ?? 14
  const avatarSize = options.avatar ? fontSize * 0.92 : 0
  const avatarGap = options.avatar ? fontSize * 0.34 : 0
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D context is unavailable')

  context.font = `800 ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`
  const metrics = context.measureText(text)
  const width = Math.ceil(metrics.width + avatarSize + avatarGap + padding * 2)
  const height = Math.ceil(fontSize + padding * 1.4)
  canvas.width = Math.ceil(width * dpr)
  canvas.height = Math.ceil(height * dpr)
  context.scale(dpr, dpr)
  context.font = `800 ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`
  context.textBaseline = 'middle'
  context.fillStyle = options.background ?? 'rgba(255, 255, 255, 0.92)'
  drawRoundedCanvasRect(context, 0, 0, width, height, 9)
  context.fill()

  let textX = padding
  if (options.avatar) {
    if (options.avatar.image) {
      drawProfileImageAvatar(context, options.avatar.image, padding, (height - avatarSize) / 2, avatarSize)
    } else {
      drawProfileAvatar(context, options.avatar.fallback, padding, (height - avatarSize) / 2, avatarSize)
    }
    textX += avatarSize + avatarGap
  }

  context.fillStyle = options.color ?? '#23262d'
  context.fillText(text, textX, height / 2 + 1)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(width * 0.014, height * 0.014, 1)
  sprite.renderOrder = 40
  return sprite
}

function createTileTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 768
  canvas.height = 768
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D context is unavailable')

  context.fillStyle = '#e4e0d8'
  context.fillRect(0, 0, canvas.width, canvas.height)

  const tile = 96
  for (let y = 0; y < canvas.height; y += tile) {
    for (let x = 0; x < canvas.width; x += tile) {
      const baseLight = 83 + randomUnit(`${x}:${y}`, 'light') * 4
      const alternateLight = baseLight + 1.6 + randomUnit(`${x}:${y}`, 'alternate') * 2.4
      const base = `hsl(39 18% ${baseLight}%)`
      const alternate = `hsl(39 19% ${alternateLight}%)`
      const descending = randomUnit(`${x}:${y}`, 'split') > 0.48
      context.fillStyle = base
      context.fillRect(x, y, tile, tile)

      context.fillStyle = alternate
      context.beginPath()
      if (descending) {
        context.moveTo(x, y)
        context.lineTo(x + tile, y + tile)
        context.lineTo(x, y + tile)
      } else {
        context.moveTo(x, y)
        context.lineTo(x + tile, y)
        context.lineTo(x, y + tile)
      }
      context.closePath()
      context.fill()

      context.fillStyle = `rgba(255, 255, 255, ${0.035 + randomUnit(`${x}:${y}`, 'facet') * 0.055})`
      context.beginPath()
      context.moveTo(x + tile * 0.5, y)
      context.lineTo(x + tile, y + tile * 0.5)
      context.lineTo(x + tile * 0.5, y + tile)
      context.closePath()
      context.fill()

      context.strokeStyle = 'rgba(112, 111, 106, 0.055)'
      context.lineWidth = 1
      context.beginPath()
      if (descending) {
        context.moveTo(x, y)
        context.lineTo(x + tile, y + tile)
      } else {
        context.moveTo(x + tile, y)
        context.lineTo(x, y + tile)
      }
      context.stroke()
    }
  }

  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const noise = ((hashInt(`floor:${index}`) % 19) - 9) * 0.58
    image.data[index] = Math.max(0, Math.min(255, image.data[index] + noise))
    image.data[index + 1] = Math.max(0, Math.min(255, image.data[index + 1] + noise))
    image.data[index + 2] = Math.max(0, Math.min(255, image.data[index + 2] + noise))
  }
  context.putImageData(image, 0, 0)

  context.strokeStyle = 'rgba(255, 255, 255, 0.105)'
  context.lineWidth = 1
  for (let offset = -canvas.height; offset < canvas.width; offset += 48) {
    context.beginPath()
    context.moveTo(offset, 0)
    context.lineTo(offset + canvas.height, canvas.height)
    context.stroke()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(30, 30)
  texture.anisotropy = 8
  return texture
}

function createFallbackAsset(spec: AssetSpec) {
  const group = new THREE.Group()
  const material = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.72, metalness: 0.03 })

  if (spec.fallback === 'plant') {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.28, 0.36, 12), material)
    const leafMaterial = new THREE.MeshStandardMaterial({ color: 0x47795c, roughness: 0.88 })
    pot.position.y = 0.18
    pot.castShadow = true
    pot.receiveShadow = true
    group.add(pot)
    for (let index = 0; index < 5; index += 1) {
      const leaf = new THREE.Mesh(new THREE.DodecahedronGeometry(0.24, 0), leafMaterial)
      leaf.position.set(Math.cos(index * 1.27) * 0.18, 0.58 + (index % 2) * 0.08, Math.sin(index * 1.27) * 0.18)
      leaf.scale.set(1.15, 0.72, 0.82)
      leaf.castShadow = true
      group.add(leaf)
    }
    return group
  }

  if (spec.fallback === 'chair') {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.18, 0.58), material)
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.64, 0.16), material)
    seat.position.y = 0.46
    back.position.set(0, 0.78, -0.27)
    group.add(seat, back)
    return group
  }

  if (spec.fallback === 'sofa') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(spec.footprint[0], 0.44, spec.footprint[1]), material)
    const back = new THREE.Mesh(new THREE.BoxGeometry(spec.footprint[0], 0.72, 0.22), material)
    base.position.y = 0.35
    back.position.set(0, 0.72, -spec.footprint[1] / 2 + 0.08)
    group.add(base, back)
    return group
  }

  if (spec.fallback === 'screen') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(spec.footprint[0], spec.maxHeight, 0.08), material)
    base.position.y = spec.maxHeight / 2
    group.add(base)
    return group
  }

  if (spec.fallback === 'rug') {
    const rug = makeRoundedPlane(spec.footprint[0], spec.footprint[1], 0.3, material)
    rug.position.y = 0.018
    group.add(rug)
    return group
  }

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(spec.footprint[0], Math.max(0.16, spec.maxHeight), spec.footprint[1]),
    material,
  )
  box.position.y = Math.max(0.16, spec.maxHeight) / 2
  box.castShadow = true
  box.receiveShadow = true
  group.add(box)
  return group
}

function makeAssetObject(key: AssetKey, options: AssetPlacementOptions = {}) {
  const spec = OFFICE_ASSETS[key]
  const cached = assetCache.get(key)
  const source = cached?.scene
  const object = source?.clone(true) ?? createFallbackAsset(spec)
  if (!source) {
    setModelShadows(object)
  } else if (options.scale !== undefined) {
    object.scale.multiplyScalar(options.scale)
  }
  if (source && options.tint !== undefined) cloneObjectMaterials(object)
  if (options.tint !== undefined) tintObject(object, options.tint)
  return object
}

function tintObject(object: THREE.Object3D, tint: number) {
  object.traverse((child) => {
    if (!isMesh(child)) return
    const material = Array.isArray(child.material) ? child.material[0] : child.material
    if ('color' in material && material.color instanceof THREE.Color) {
      material.color.lerp(new THREE.Color(tint), 0.18)
    }
  })
}

function addAsset(
  parent: THREE.Group,
  key: AssetKey,
  x: number,
  z: number,
  rotation = 0,
  options: AssetPlacementOptions = {},
) {
  const group = new THREE.Group()
  const object = makeAssetObject(key, options)
  group.position.set(x, options.y ?? ASSET_BASE_LIFT[key] ?? 0, z)
  group.rotation.y = rotation
  group.add(object)
  parent.add(group)
  return group
}

function userProfileImageCandidates(user?: MockUser) {
  return user?.pictureCandidates?.length ? user.pictureCandidates : user?.pictureUrl ? [user.pictureUrl] : []
}

function createLabelSprite(pubkey: string, label: string, image?: HTMLImageElement) {
  return makeTextSprite(label, {
    background: 'rgba(32, 34, 39, 0.92)',
    color: '#ffffff',
    fontSize: 24,
    padding: 12,
    avatar: label ? { fallback: avatarFromPubkey(pubkey), image } : undefined,
  })
}

function createAvatar(pubkey: string, labelText: string) {
  const style = avatarFromPubkey(pubkey)
  const group = new THREE.Group()
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(style.body), roughness: 0.72 })
  const trimMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(style.trim), roughness: 0.76 })
  const skinMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(style.skin), roughness: 0.78 })
  const hairMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color(style.hair), roughness: 0.84 })
  const shoeMaterial = new THREE.MeshStandardMaterial({ color: 0x2e333a, roughness: 0.82 })

  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.48, 28), new THREE.MeshBasicMaterial({ color: 0x1d2528, opacity: 0.1, transparent: true }))
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.012
  group.add(shadow)

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.46, 5, 10), bodyMaterial)
  body.position.y = 0.82
  body.castShadow = true
  group.add(body)

  const trim = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.32), trimMaterial)
  trim.position.y = 0.91
  trim.castShadow = true
  group.add(trim)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), skinMaterial)
  head.position.y = 1.26
  head.castShadow = true
  group.add(head)

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.235, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMaterial)
  hair.position.y = 1.38
  hair.castShadow = true
  group.add(hair)

  const face = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), hairMaterial)
  face.position.set(0, 1.28, -0.21)
  group.add(face)

  const leftArm = createLimb(0.055, 0.48, bodyMaterial, [-0.28, 0.86, -0.02])
  const rightArm = createLimb(0.055, 0.48, bodyMaterial, [0.28, 0.86, -0.02])
  const leftLeg = createLimb(0.065, 0.52, shoeMaterial, [-0.11, 0.42, 0.02])
  const rightLeg = createLimb(0.065, 0.52, shoeMaterial, [0.11, 0.42, 0.02])
  group.add(leftArm, rightArm, leftLeg, rightLeg)

  const label = createLabelSprite(pubkey, labelText)
  label.position.set(0, 1.78, 0)
  label.visible = Boolean(labelText)
  group.add(label)

  return {
    group,
    body,
    label,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    current: new THREE.Vector2(),
    target: new THREE.Vector2(),
    labelText,
    labelAvatarKey: '',
    walkingUntil: 0,
    lastSnapshotAt: 0,
  } satisfies AvatarNode
}

function createLimb(radius: number, height: number, material: THREE.Material, position: [number, number, number]) {
  const pivot = new THREE.Group()
  pivot.position.set(...position)
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 10), material)
  mesh.position.y = -height / 2
  mesh.castShadow = true
  pivot.add(mesh)
  return pivot
}

function roomLabelForTone(seed: string, tone: OfficeTone) {
  const labels: Record<OfficeTone, readonly string[]> = {
    work: ['Product', 'Ops', 'Build', 'Research'],
    lounge: ['Coffee area', 'Lounge', 'Random coffee', 'Quiet'],
    garden: ['Garden', 'Atrium', 'Plants', 'Open space'],
    meeting: ['Design', 'Studio', 'Focus', 'Workshop'],
  }
  return randomChoice(seed, 'label', labels[tone])
}

function roomTone(seed: string) {
  return randomChoice(seed, 'tone', ['work', 'meeting', 'lounge', 'garden'] as const)
}

function roomForChunk(seed: string, chunkX: number, chunkZ: number, index: number): RoomPlan | undefined {
  const chunkSeed = `${seed}:room:${chunkX}:${chunkZ}:${index}`
  const density = index === 0 || chunkX === 0 || chunkZ === 0 ? 0.86 : 0.58
  if (randomUnit(chunkSeed, 'density') > density) return undefined

  const tone = roomTone(chunkSeed)
  const width = randomBetween(chunkSeed, 'width', tone === 'lounge' ? 8.8 : 9.8, tone === 'work' ? 15.6 : 13.5)
  const depth = randomBetween(chunkSeed, 'depth', 6.7, tone === 'garden' ? 11.6 : 9.7)
  const x = chunkX * CHUNK_SIZE + randomBetween(chunkSeed, 'x', -5.8, 5.8)
  const z = chunkZ * CHUNK_SIZE + randomBetween(chunkSeed, 'z', -5.4, 5.4)
  const rotation = randomChoice(chunkSeed, 'rotation', [0, 0, 0, Math.PI / 2] as const)
  return {
    id: `${chunkX}:${chunkZ}:${index}`,
    label: roomLabelForTone(chunkSeed, tone),
    tone,
    x,
    z,
    width,
    depth,
    rotation,
    seed: chunkSeed,
  }
}

function roomBounds(room: RoomPlan, margin = 1.65) {
  const rotated = Math.abs(Math.sin(room.rotation)) > 0.5
  const width = rotated ? room.depth : room.width
  const depth = rotated ? room.width : room.depth
  return {
    left: room.x - width / 2 - margin,
    right: room.x + width / 2 + margin,
    top: room.z - depth / 2 - margin,
    bottom: room.z + depth / 2 + margin,
  }
}

function roomsOverlap(a: RoomPlan, b: RoomPlan) {
  const first = roomBounds(a)
  const second = roomBounds(b)
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  )
}

function roomPriority(room: RoomPlan) {
  return hashInt(`${room.seed}:priority`)
}

function roomLocal(room: RoomPlan, x: number, z: number) {
  const cos = Math.cos(room.rotation)
  const sin = Math.sin(room.rotation)
  return {
    x: room.x + x * cos - z * sin,
    z: room.z + x * sin + z * cos,
    rotation: room.rotation,
  }
}

function furnishRoom(parent: THREE.Group, room: RoomPlan) {
  const items = new THREE.Group()
  items.rotation.y = room.rotation
  items.position.set(room.x, 0, room.z)
  parent.add(items)

  if (room.tone === 'lounge') {
    addAsset(items, 'roundRug', 0, 0, 0, { scale: 1.12, tint: 0x83a0ac })
    addAsset(items, 'coffeeTable', 0, 0.1, 0)
    addAsset(items, 'couchMedium', 0, -room.depth * 0.23, 0, { tint: 0x93abb3 })
    addAsset(items, 'couchSmall', -room.width * 0.25, 0.25, Math.PI / 2, { tint: 0x9db89e })
    addAsset(items, 'couchSmall', room.width * 0.25, 0.25, -Math.PI / 2, { tint: 0xa9beab })
    addAsset(items, 'plantWhitePot', -room.width * 0.37, -room.depth * 0.32, 0)
    addAsset(items, 'lamp', room.width * 0.35, -room.depth * 0.3, 0)
    return
  }

  if (room.tone === 'meeting') {
    addAsset(items, 'rug', 0, 0, 0, { scale: 1.25, tint: 0xb8c6d6 })
    addAsset(items, 'tableRound', 0, 0, 0)
    for (let index = 0; index < 6; index += 1) {
      const angle = (index / 6) * Math.PI * 2
      const x = Math.cos(angle) * 1.75
      const z = Math.sin(angle) * 1.75
      addAsset(items, 'officeChair', x, z, -angle + Math.PI, { tint: 0x61748b })
    }
    addAsset(items, 'whiteboard', 0, -room.depth / 2 + 0.42, 0)
    addAsset(items, 'pottedPlant', room.width / 2 - 1.2, room.depth / 2 - 1.0, 0)
    return
  }

  if (room.tone === 'garden') {
    addAsset(items, 'roundRug', -room.width * 0.18, 0.15, 0, { scale: 1.25, tint: 0x9fb79f })
    addAsset(items, 'table', 0.6, 0.25, 0)
    addAsset(items, 'couchSmall', -room.width * 0.3, 0.2, Math.PI / 2, { tint: 0xaec5a8 })
    addAsset(items, 'houseplant', -room.width * 0.38, -room.depth * 0.32, 0)
    addAsset(items, 'houseplant', -room.width * 0.18, -room.depth * 0.38, 0)
    addAsset(items, 'plantWhitePot', room.width * 0.35, -room.depth * 0.28, 0)
    addAsset(items, 'pottedPlant', room.width * 0.36, room.depth * 0.3, 0)
    addAsset(items, 'waterCooler', -room.width * 0.36, room.depth * 0.32, Math.PI / 2)
    return
  }

  const deskRows = room.width > 13 ? 3 : 2
  for (let index = 0; index < deskRows; index += 1) {
    const x = -room.width * 0.28 + index * (room.width * 0.28)
    const z = randomBetween(room.seed, `desk-z-${index}`, -room.depth * 0.18, room.depth * 0.2)
    const deskKey = randomChoice(room.seed, `desk-${index}`, ['desk', 'standingDesk', 'adjustableDesk'] as const)
    addAsset(items, deskKey, x, z, 0)
    addAsset(items, 'officeChair', x, z + 0.92, Math.PI, { tint: 0x5f7084 })
    addAsset(items, randomChoice(room.seed, `screen-${index}`, ['monitor', 'computerScreen', 'dualMonitors'] as const), x - 0.18, z - 0.18, 0, {
      y: 0.78,
      scale: 0.68,
    })
    if (index % 2 === 0) addAsset(items, 'bookStack', x + 0.58, z - 0.15, 0, { y: 0.76, scale: 0.62 })
  }
  addAsset(items, 'fileCabinet', room.width / 2 - 0.95, room.depth / 2 - 0.95, Math.PI / 2)
  addAsset(items, 'shelf', -room.width / 2 + 1.3, room.depth / 2 - 0.46, 0)
  addAsset(items, 'plantWhitePot', -room.width / 2 + 1.05, -room.depth / 2 + 1.0, 0)
}

class ThreeOffice {
  private host: HTMLDivElement
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera()
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private floor: THREE.Mesh
  private worldRoot = new THREE.Group()
  private avatarRoot = new THREE.Group()
  private avatars = new Map<string, AvatarNode>()
  private keys = new Set<string>()
  private cameraCenter = new THREE.Vector3()
  private cameraDesired = new THREE.Vector3()
  private cameraDetached = false
  private cameraViewScale = 1
  private cameraTargetViewScale = 1
  private cameraDrag?: CameraDragState
  private target?: THREE.Vector2
  private snapshot?: OfficeSceneSnapshot
  private onMove: MoveHandler
  private canPlaceSelf: boolean
  private frame = 0
  private lastTime = performance.now()
  private lastKeyboardIntentAt = 0
  private lastKeyboardIntentKey = ''
  private lastIntentRequiresStop = false
  private worldCenterChunkX = Number.NaN
  private worldCenterChunkZ = Number.NaN
  private worldSeed = ''
  private worldAssetVersion = -1
  private queuedWorldRebuild?: number
  private assetVersion = 0
  private localEchoHoldUntil = 0
  private followedSelfPubkey = ''
  private resizeObserver?: ResizeObserver
  private previousAvatarPosition = new THREE.Vector2()
  private trajectoryDelta = new THREE.Vector2()

  constructor(host: HTMLDivElement, onMove: MoveHandler, canPlaceSelf = true) {
    this.host = host
    this.onMove = onMove
    this.canPlaceSelf = canPlaceSelf
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_RENDER_PIXEL_RATIO))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.domElement.dataset.testid = 'office-webgl-canvas'
    this.host.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(0xe7e4dc)
    this.scene.fog = new THREE.Fog(0xe7e4dc, 70, 128)
    this.floor = this.createFloor()
    this.scene.add(this.floor, this.worldRoot, this.avatarRoot)
    this.addLights()
    this.bindEvents()
    this.resize()
    this.preloadAssets()
    this.frame = window.requestAnimationFrame(this.tick)
  }

  dispose() {
    window.cancelAnimationFrame(this.frame)
    if (this.queuedWorldRebuild !== undefined) window.clearTimeout(this.queuedWorldRebuild)
    this.resizeObserver?.disconnect()
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown)
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove)
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp)
    this.renderer.domElement.removeEventListener('pointercancel', this.handlePointerCancel)
    this.renderer.domElement.removeEventListener('wheel', this.handleWheel)
    this.renderer.domElement.removeEventListener('contextmenu', this.preventContextMenu)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  setMoveHandler(onMove: MoveHandler) {
    this.onMove = onMove
  }

  moveSelfNear(position: JumpTarget) {
    if (!this.canPlaceSelf) return
    const node = this.selfNode()
    if (!node) return

    const destination = this.approachTargetForWorldPosition(position)
    const x = worldToSceneX(destination.x)
    const z = worldToSceneZ(destination.y)
    this.keys.clear()
    this.resetCameraTracking()
    this.target = new THREE.Vector2(x, z)
    this.emitMoveIntent(this.target, CLICK_SPEED)
    this.lastIntentRequiresStop = false
  }

  setCanPlaceSelf(canPlaceSelf: boolean) {
    this.canPlaceSelf = canPlaceSelf
    if (!canPlaceSelf) {
      this.keys.clear()
      this.target = undefined
      this.followedSelfPubkey = ''
    }
    this.syncAvatars()
  }

  applySnapshot(snapshot: OfficeSceneSnapshot) {
    const previousSeed = this.snapshot?.map.seed
    this.snapshot = snapshot
    this.syncAvatars()
    if (previousSeed !== snapshot.map.seed) {
      this.worldSeed = ''
      this.rebuildWorld(true)
    }
  }

  private preloadAssets() {
    Object.values(OFFICE_ASSETS).forEach((spec) => {
      void loadAsset(spec)
        .then(() => {
          this.assetVersion += 1
          this.scheduleWorldRebuild()
        })
        .catch(() => {
          this.assetVersion += 1
        })
    })
  }

  private scheduleWorldRebuild() {
    if (this.queuedWorldRebuild !== undefined) return
    this.queuedWorldRebuild = window.setTimeout(() => {
      this.queuedWorldRebuild = undefined
      this.rebuildWorld(true)
    }, 140)
  }

  private bindEvents() {
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.host)
    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown)
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove)
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp)
    this.renderer.domElement.addEventListener('pointercancel', this.handlePointerCancel)
    this.renderer.domElement.addEventListener('wheel', this.handleWheel, { passive: false })
    this.renderer.domElement.addEventListener('contextmenu', this.preventContextMenu)
  }

  private createFloor() {
    const texture = createTileTexture()
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.96,
      metalness: 0,
      color: 0xf4f1ea,
    })
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(260, 260, 1, 1), material)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    return floor
  }

  private addLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 1.45)
    this.scene.add(ambient)

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0xd9ddd6, 1.2)
    this.scene.add(hemisphere)

    const sun = new THREE.DirectionalLight(0xffffff, 1.65)
    sun.position.set(-4, 48, -4)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.bias = -0.00005
    sun.shadow.normalBias = 0.12
    sun.shadow.radius = 10
    sun.shadow.blurSamples = 8
    sun.shadow.camera.near = 2
    sun.shadow.camera.far = 96
    sun.shadow.camera.left = -52
    sun.shadow.camera.right = 52
    sun.shadow.camera.top = 52
    sun.shadow.camera.bottom = -52
    this.scene.add(sun)

    const fill = new THREE.DirectionalLight(0xe7edf7, 0.55)
    fill.position.set(18, 36, 22)
    this.scene.add(fill)
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (!this.canPlaceSelf) return
    if (event.defaultPrevented || this.isTypingTarget(event.target)) return
    if (!this.isMovementKey(event.key)) return
    this.resetCameraTracking()
    this.keys.add(event.key.toLowerCase())
    event.preventDefault()
  }

  private handleKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.key.toLowerCase())
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return
    if (event.target !== this.renderer.domElement) return
    this.cameraDrag = {
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      dragging: false,
    }
    this.renderer.domElement.setPointerCapture(event.pointerId)
  }

  private handlePointerMove = (event: PointerEvent) => {
    if (!this.cameraDrag || event.pointerId !== this.cameraDrag.pointerId) return
    const totalDistance = Math.hypot(event.clientX - this.cameraDrag.startX, event.clientY - this.cameraDrag.startY)
    if (!this.cameraDrag.dragging && totalDistance < CAMERA_DRAG_THRESHOLD) return

    this.cameraDrag.dragging = true
    this.panCameraByPixels(event.clientX - this.cameraDrag.lastX, event.clientY - this.cameraDrag.lastY)
    this.cameraDrag.lastX = event.clientX
    this.cameraDrag.lastY = event.clientY
    event.preventDefault()
  }

  private handlePointerUp = (event: PointerEvent) => {
    if (!this.cameraDrag || event.pointerId !== this.cameraDrag.pointerId) return
    const wasDragging = this.cameraDrag.dragging
    const button = this.cameraDrag.button
    this.cameraDrag = undefined
    this.renderer.domElement.releasePointerCapture(event.pointerId)
    if (wasDragging || button !== 0) {
      event.preventDefault()
      return
    }
    this.handleMapClick(event)
  }

  private handlePointerCancel = (event: PointerEvent) => {
    if (!this.cameraDrag || event.pointerId !== this.cameraDrag.pointerId) return
    this.cameraDrag = undefined
    this.renderer.domElement.releasePointerCapture(event.pointerId)
  }

  private handleMapClick(event: PointerEvent) {
    if (!this.canPlaceSelf) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)

    const avatarHit = this.raycaster
      .intersectObjects(this.avatarRoot.children, true)
      .map((hit) => this.pubkeyForObject(hit.object))
      .find((pubkey) => pubkey && pubkey !== this.snapshot?.selfPubkey)

    if (avatarHit) {
      const node = this.avatars.get(avatarHit)
      if (node) {
        this.resetCameraTracking()
        this.target = this.approachTargetForAvatar(node)
        this.emitMoveIntent(this.target, CLICK_SPEED)
        event.preventDefault()
        return
      }
    }

    const intersection = new THREE.Vector3()
    this.raycaster.ray.intersectPlane(this.groundPlane, intersection)
    this.resetCameraTracking()
    this.target = new THREE.Vector2(intersection.x, intersection.z)
    this.emitMoveIntent(this.target, CLICK_SPEED)
  }

  private handleWheel = (event: WheelEvent) => {
    if (event.target !== this.renderer.domElement) return
    event.preventDefault()
    const multiplier = Math.exp(event.deltaY * 0.0012)
    const nextScale = THREE.MathUtils.clamp(this.cameraViewScale * multiplier, 1, MAX_CAMERA_VIEW_SCALE)
    if (nextScale === this.cameraViewScale) return
    this.cameraDetached = true
    this.cameraViewScale = nextScale
    this.cameraTargetViewScale = nextScale
    this.applyCameraProjection()
  }

  private preventContextMenu = (event: MouseEvent) => {
    if (this.cameraDrag?.dragging) event.preventDefault()
  }

  private pubkeyForObject(object: THREE.Object3D) {
    let current: THREE.Object3D | null = object
    while (current) {
      const pubkey = current.userData.pubkey
      if (typeof pubkey === 'string') return pubkey
      current = current.parent
    }
    return null
  }

  private isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false
    const tag = target.tagName.toLowerCase()
    return tag === 'input' || tag === 'textarea' || target.isContentEditable
  }

  private isMovementKey(key: string) {
    return ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key.toLowerCase())
  }

  private resize() {
    this.applyCameraProjection()
    this.renderer.setSize(Math.max(this.host.clientWidth, 1), Math.max(this.host.clientHeight, 1), false)
  }

  private baseViewHeight() {
    return Math.max(this.host.clientWidth, 1) < 620 ? 22 : CAMERA_VIEW_HEIGHT
  }

  private currentViewHeight() {
    return this.baseViewHeight() * this.cameraViewScale
  }

  private cameraAspect() {
    return Math.max(this.host.clientWidth, 1) / Math.max(this.host.clientHeight, 1)
  }

  private applyCameraProjection() {
    const width = Math.max(this.host.clientWidth, 1)
    const height = Math.max(this.host.clientHeight, 1)
    const aspect = width / height
    const viewHeight = this.currentViewHeight()
    this.camera.left = (-viewHeight * aspect) / 2
    this.camera.right = (viewHeight * aspect) / 2
    this.camera.top = viewHeight / 2
    this.camera.bottom = -viewHeight / 2
    this.camera.near = 0.1
    this.camera.far = 160
    this.camera.updateProjectionMatrix()
  }

  private tick = (time: number) => {
    const delta = Math.min(50, time - this.lastTime)
    this.lastTime = time
    this.moveSelf(delta, time)
    this.animateAvatars(time, delta, Date.now())
    this.updateCamera(delta)
    this.rebuildWorld()
    this.renderer.render(this.scene, this.camera)
    this.frame = window.requestAnimationFrame(this.tick)
  }

  private selfNode() {
    if (!this.snapshot || !this.canPlaceSelf) return undefined
    return this.avatars.get(this.snapshot.selfPubkey)
  }

  private clearSelfTrajectory(node = this.selfNode()) {
    if (!node) return
    node.trajectory = undefined
    node.target.copy(node.current)
  }

  private approachTargetForAvatar(targetNode: AvatarNode) {
    const destination = targetNode.current.clone()
    const self = this.selfNode()
    const offset = self ? self.current.clone().sub(targetNode.current) : new THREE.Vector2(1, 0)
    if (offset.lengthSq() < 0.0001) {
      const seed = Number.parseInt(targetNode.group.userData.pubkey?.slice(0, 4) ?? '1', 16)
      const angle = (Number.isFinite(seed) ? seed : 1) * 0.017
      offset.set(Math.cos(angle), Math.sin(angle))
    }
    offset.setLength(AVATAR_APPROACH_DISTANCE)
    return destination.add(offset)
  }

  private approachTargetForWorldPosition(position: JumpTarget): JumpTarget {
    const self = this.selfNode()
    if (!self) return position

    const target = new THREE.Vector2(worldToSceneX(position.x), worldToSceneZ(position.y))
    const offset = self.current.clone().sub(target)
    if (offset.lengthSq() < 0.0001) offset.set(1, 0)
    offset.setLength(AVATAR_APPROACH_DISTANCE)
    const destination = target.add(offset)
    return {
      x: sceneToWorldX(destination.x),
      y: sceneToWorldY(destination.y),
    }
  }

  private emitMoveIntent(target: THREE.Vector2, speed: number, requiresStop = false) {
    const node = this.selfNode()
    if (!node) return
    this.clearSelfTrajectory(node)
    this.localEchoHoldUntil = performance.now() + SELF_ECHO_HOLD_MS
    const startX = sceneToWorldX(node.current.x)
    const startY = sceneToWorldY(node.current.y)
    const endX = sceneToWorldX(target.x)
    const endY = sceneToWorldY(target.y)
    const distance = Math.hypot(endX - startX, endY - startY)

    this.onMove({
      startX,
      startY,
      endX,
      endY,
      speed: distance > 0.001 ? speed : 0,
    })
    this.lastIntentRequiresStop = requiresStop
    if (!requiresStop) this.lastKeyboardIntentKey = ''
  }

  private emitIdleIntent() {
    if (!this.lastIntentRequiresStop) return
    const node = this.selfNode()
    if (!node) return
    this.clearSelfTrajectory(node)
    const x = sceneToWorldX(node.current.x)
    const y = sceneToWorldY(node.current.y)
    this.onMove({
      startX: x,
      startY: y,
      endX: x,
      endY: y,
      speed: 0,
    })
    this.lastIntentRequiresStop = false
    this.lastKeyboardIntentKey = ''
  }

  private moveSelf(delta: number, time: number) {
    const node = this.selfNode()
    if (!node) return

    let x = 0
    let z = 0
    if (this.keys.has('d') || this.keys.has('arrowright')) x += 1
    if (this.keys.has('a') || this.keys.has('arrowleft')) x -= 1
    if (this.keys.has('s') || this.keys.has('arrowdown')) z += 1
    if (this.keys.has('w') || this.keys.has('arrowup')) z -= 1

    let speed = KEYBOARD_SPEED * WORLD_SCALE
    let keyboardIntent = false
    if (x !== 0 || z !== 0) {
      this.target = undefined
      this.clearSelfTrajectory(node)
      keyboardIntent = true
      const length = Math.hypot(x, z)
      x /= length
      z /= length
    } else if (this.target) {
      this.clearSelfTrajectory(node)
      const dx = this.target.x - node.current.x
      const dz = this.target.y - node.current.y
      const distance = Math.hypot(dx, dz)
      if (distance <= ARRIVAL_RADIUS) {
        this.target = undefined
        return
      }
      x = dx / distance
      z = dz / distance
      speed = CLICK_SPEED * WORLD_SCALE
      if (distance < (speed * delta) / 1000 + ARRIVAL_RADIUS) {
        this.target = undefined
      }
    }

    if (x === 0 && z === 0) {
      this.emitIdleIntent()
      return
    }

    if (keyboardIntent) {
      const intentKey = `${x.toFixed(3)}:${z.toFixed(3)}`
      if (intentKey !== this.lastKeyboardIntentKey || time - this.lastKeyboardIntentAt >= KEYBOARD_REPUBLISH_MS) {
        this.lastKeyboardIntentKey = intentKey
        this.lastKeyboardIntentAt = time
        const horizonSeconds = KEYBOARD_INTENT_HORIZON_MS / 1000
        this.emitMoveIntent(
          new THREE.Vector2(
            node.current.x + x * KEYBOARD_SPEED * WORLD_SCALE * horizonSeconds,
            node.current.y + z * KEYBOARD_SPEED * WORLD_SCALE * horizonSeconds,
          ),
          KEYBOARD_SPEED,
          true,
        )
      }
    }

    this.resetCameraTracking()
    const moveX = x * speed * (delta / 1000)
    const moveZ = z * speed * (delta / 1000)
    node.current.x += moveX
    node.current.y += moveZ
    node.target.copy(node.current)
    node.group.position.set(node.current.x, 0, node.current.y)
    this.rotateAvatarTowardDelta(node, moveX, moveZ)
    node.walkingUntil = performance.now() + 170
    this.localEchoHoldUntil = performance.now() + SELF_ECHO_HOLD_MS
  }

  private rotateAvatarTowardDelta(node: AvatarNode, dx: number, dz: number, amount = 0.28) {
    if (Math.hypot(dx, dz) <= 0.002) return
    const direction = Math.atan2(dx, dz)
    if (Number.isFinite(direction)) {
      node.group.rotation.y = THREE.MathUtils.lerp(node.group.rotation.y, direction + Math.PI, amount)
    }
  }

  private animateAvatars(time: number, delta: number, wallTime: number) {
    const lerp = 1 - Math.exp(-delta / 118)
    const now = performance.now()
    this.avatars.forEach((node) => {
      if (node.trajectory) {
        this.trajectoryPointAt(node.trajectory, wallTime, node.target)
        if (node.target.distanceTo(node.current) > 0.002) node.walkingUntil = now + 120
      }
      this.previousAvatarPosition.copy(node.current)
      node.current.lerp(node.target, lerp)
      node.group.position.set(node.current.x, 0, node.current.y)

      const movedDistance = node.current.distanceTo(this.previousAvatarPosition)
      const moving = movedDistance > 0.002 || now < node.walkingUntil
      if (moving) {
        if (movedDistance > 0.002) {
          this.rotateAvatarTowardDelta(
            node,
            node.current.x - this.previousAvatarPosition.x,
            node.current.y - this.previousAvatarPosition.y,
            0.18,
          )
        }
      }

      const swing = moving ? Math.sin(time / 92) : 0
      const bob = moving ? Math.abs(Math.sin(time / 116)) * 0.055 : 0
      node.body.position.y = 0.82 + bob
      node.leftArm.rotation.x = -swing * 0.58
      node.rightArm.rotation.x = swing * 0.58
      node.leftLeg.rotation.x = swing * 0.46
      node.rightLeg.rotation.x = -swing * 0.46
    })
  }

  private trajectoryForPosition(position: WorldPosition): AvatarTrajectory | undefined {
    if (
      typeof position.startX !== 'number' ||
      typeof position.startY !== 'number' ||
      typeof position.targetX !== 'number' ||
      typeof position.targetY !== 'number' ||
      typeof position.speed !== 'number' ||
      typeof position.sentAt !== 'number'
    ) {
      return undefined
    }

    return {
      start: new THREE.Vector2(worldToSceneX(position.startX), worldToSceneZ(position.startY)),
      end: new THREE.Vector2(worldToSceneX(position.targetX), worldToSceneZ(position.targetY)),
      speed: position.speed * WORLD_SCALE,
      sentAt: position.sentAt,
    }
  }

  private trajectoryPointAt(trajectory: AvatarTrajectory, at: number, target = new THREE.Vector2()) {
    this.trajectoryDelta.copy(trajectory.end).sub(trajectory.start)
    const distance = this.trajectoryDelta.length()
    if (trajectory.speed <= 0 || distance <= 0) return target.copy(trajectory.end)
    const durationMs = (distance / trajectory.speed) * 1000
    const progress = THREE.MathUtils.clamp((at - trajectory.sentAt) / durationMs, 0, 1)
    return target.copy(trajectory.start).lerp(trajectory.end, progress)
  }

  private updateCamera(delta: number) {
    const self = this.selfNode()
    if (!this.cameraDetached && self) {
      this.setCameraDesired(self.current.x, self.current.y)
    }

    this.updateCameraZoom(delta)
    const follow = 1 - Math.exp(-delta / 190)
    this.cameraCenter.lerp(this.cameraDesired, follow)
    this.applyCameraTransform()
  }

  private updateCameraZoom(delta: number) {
    if (this.cameraViewScale === this.cameraTargetViewScale) return
    const previousScale = this.cameraViewScale
    const zoom = 1 - Math.exp(-delta / CAMERA_ZOOM_RESET_MS)
    this.cameraViewScale = THREE.MathUtils.lerp(this.cameraViewScale, this.cameraTargetViewScale, zoom)
    if (Math.abs(this.cameraViewScale - this.cameraTargetViewScale) < 0.003) {
      this.cameraViewScale = this.cameraTargetViewScale
    }
    if (this.cameraViewScale !== previousScale) this.applyCameraProjection()
  }

  private setCameraDesired(x: number, z: number) {
    this.cameraDesired.set(x, 0, z)
  }

  private panCameraByPixels(dx: number, dy: number) {
    const viewHeight = this.currentViewHeight()
    const unitsPerPixelX = (viewHeight * this.cameraAspect()) / Math.max(this.host.clientWidth, 1)
    const unitsPerPixelY = viewHeight / Math.max(this.host.clientHeight, 1)
    this.cameraDetached = true
    this.cameraTargetViewScale = this.cameraViewScale
    this.cameraDesired.x -= dx * unitsPerPixelX
    this.cameraDesired.z -= dy * unitsPerPixelY
    this.cameraCenter.copy(this.cameraDesired)
    this.applyCameraTransform()
  }

  private resetCameraTracking() {
    if (!this.cameraDetached && this.cameraTargetViewScale === 1) return
    this.cameraDetached = false
    this.cameraTargetViewScale = 1
    const self = this.selfNode()
    if (self) this.snapCameraTo(self.current.x, self.current.y)
  }

  private snapCameraTo(x: number, z: number) {
    this.setCameraDesired(x, z)
    this.cameraCenter.set(x, 0, z)
    this.applyCameraTransform()
  }

  private applyCameraTransform() {
    this.floor.position.set(this.cameraCenter.x, -0.006, this.cameraCenter.z)
    this.camera.position.set(this.cameraCenter.x, 31, this.cameraCenter.z + 27)
    this.camera.lookAt(this.cameraCenter.x, 0, this.cameraCenter.z)
  }

  private rebuildWorld(force = false) {
    if (!this.snapshot) return
    const centerX = Math.floor(this.cameraCenter.x / CHUNK_SIZE)
    const centerZ = Math.floor(this.cameraCenter.z / CHUNK_SIZE)
    if (
      !force &&
      this.worldSeed === this.snapshot.map.seed &&
      this.worldAssetVersion === this.assetVersion &&
      Math.abs(centerX - this.worldCenterChunkX) <= WORLD_REBUILD_HYSTERESIS_CHUNKS &&
      Math.abs(centerZ - this.worldCenterChunkZ) <= WORLD_REBUILD_HYSTERESIS_CHUNKS
    ) {
      return
    }
    this.worldSeed = this.snapshot.map.seed
    this.worldAssetVersion = this.assetVersion
    this.worldCenterChunkX = centerX
    this.worldCenterChunkZ = centerZ
    this.worldRoot.clear()

    this.addSoftFloorWash()
    const candidates: RoomPlan[] = []
    for (let chunkZ = centerZ - ROOM_BUFFER_RANGE; chunkZ <= centerZ + ROOM_BUFFER_RANGE; chunkZ += 1) {
      for (let chunkX = centerX - ROOM_BUFFER_RANGE; chunkX <= centerX + ROOM_BUFFER_RANGE; chunkX += 1) {
        for (let index = 0; index < 2; index += 1) {
          const room = roomForChunk(this.snapshot.map.seed, chunkX, chunkZ, index)
          if (room) candidates.push(room)
        }
      }
    }

    const rooms: RoomPlan[] = []
    candidates
      .sort((a, b) => {
        const priorityA = roomPriority(a)
        const priorityB = roomPriority(b)
        if (priorityA !== priorityB) return priorityA - priorityB
        return a.id.localeCompare(b.id)
      })
      .forEach((candidate) => {
        if (rooms.some((room) => roomsOverlap(room, candidate))) return
        rooms.push(candidate)
      })

    rooms.forEach((room) => this.addRoom(room))
  }

  private addSoftFloorWash() {
    const mesh = new THREE.Mesh(softFloorWashGeometry, softFloorWashMaterial)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(this.cameraCenter.x, 0.021, this.cameraCenter.z)
    this.worldRoot.add(mesh)
  }

  private addRoom(room: RoomPlan) {
    const roomGroup = new THREE.Group()
    roomGroup.position.set(room.x, 0, room.z)
    roomGroup.rotation.y = room.rotation
    this.worldRoot.add(roomGroup)

    const shadow = makeRoundedPlane(room.width, room.depth, 1.25, new THREE.MeshBasicMaterial({ color: 0x222222, opacity: 0.04, transparent: true }))
    shadow.position.set(0.3, 0.006, 0.38)
    roomGroup.add(shadow)

    const pad = makeRoundedPlane(room.width, room.depth, 1.05, roomMaterials[room.tone])
    pad.position.y = 0.018
    roomGroup.add(pad)

    const walls = makeRoomWall(room.width, room.depth)
    roomGroup.add(walls)

    const labelWorld = roomLocal(room, -room.width / 2 + 1.5, -room.depth / 2 + 0.65)
    const label = makeTextSprite(room.label, { fontSize: 21, padding: 10, background: 'rgba(255, 255, 255, 0.86)' })
    label.position.set(labelWorld.x, 0.72, labelWorld.z)
    this.worldRoot.add(label)

    furnishRoom(this.worldRoot, room)
  }

  private syncAvatars() {
    if (!this.snapshot) return
    const users = new Map(this.snapshot.users.map((user) => [user.pubkey, user]))
    const positions = this.snapshot.positions.filter(
      (position) => this.canPlaceSelf || position.pubkey !== this.snapshot?.selfPubkey,
    )
    const active = new Set(positions.map((position) => position.pubkey))
    const labels = this.avatarLabels(users)

    this.avatars.forEach((node, pubkey) => {
      if (active.has(pubkey)) return
      this.avatarRoot.remove(node.group)
      this.avatars.delete(pubkey)
    })

    positions.forEach((position) => {
      const user = users.get(position.pubkey)
      const label = labels.get(position.pubkey) ?? this.labelFor(position, user)
      const labelAvatarKey = profileImageKey(userProfileImageCandidates(user))
      const isSelf = this.canPlaceSelf && position.pubkey === this.snapshot?.selfPubkey
      const trajectory = this.trajectoryForPosition(position)
      const current = trajectory ? this.trajectoryPointAt(trajectory, Date.now()) : new THREE.Vector2(worldToSceneX(position.x), worldToSceneZ(position.y))
      const target = trajectory?.end ?? new THREE.Vector2(worldToSceneX(position.x), worldToSceneZ(position.y))
      let node = this.avatars.get(position.pubkey)
      if (!node) {
        node = createAvatar(position.pubkey, label)
        node.group.userData.pubkey = position.pubkey
        node.label.userData.pubkey = position.pubkey
        node.current.copy(current)
        node.target.copy(target)
        node.trajectory = trajectory
        node.group.position.set(current.x, 0, current.y)
        if (isSelf) {
          const ring = new THREE.Mesh(new THREE.CircleGeometry(3.05, 56), ringMaterial)
          ring.rotation.x = -Math.PI / 2
          ring.position.y = 0.02
          node.group.add(ring)
        }
        this.avatarRoot.add(node.group)
        this.avatars.set(position.pubkey, node)
      }

      if (node.labelAvatarKey !== labelAvatarKey) {
        node.labelAvatarKey = labelAvatarKey
        if (labelAvatarKey) void this.refreshAvatarLabelImage(position.pubkey, label, labelAvatarKey)
      }

      if (isSelf && this.followedSelfPubkey !== position.pubkey) {
        this.followedSelfPubkey = position.pubkey
        this.snapCameraTo(node.current.x, node.current.y)
      }

      if (node.labelText !== label) {
        this.replaceAvatarLabel(position.pubkey, label)
        node.labelText = label
        if (labelAvatarKey) void this.refreshAvatarLabelImage(position.pubkey, label, labelAvatarKey)
      }

      if (
        this.canPlaceSelf &&
        position.pubkey === this.snapshot?.selfPubkey &&
        performance.now() < this.localEchoHoldUntil
      ) {
        node.trajectory = undefined
        node.target.copy(node.current)
        return
      }

      node.trajectory = trajectory
      if (target.distanceTo(node.target) > 0.02) node.walkingUntil = performance.now() + 260
      node.target.copy(target)
      node.lastSnapshotAt = position.updatedAt
    })
  }

  private replaceAvatarLabel(pubkey: string, label: string, image?: HTMLImageElement) {
    const node = this.avatars.get(pubkey)
    if (!node) return
    node.group.remove(node.label)
    node.label = createLabelSprite(pubkey, label, image)
    node.label.position.set(0, 1.78, 0)
    node.label.visible = Boolean(label)
    node.label.userData.pubkey = pubkey
    node.group.add(node.label)
  }

  private async refreshAvatarLabelImage(pubkey: string, label: string, labelAvatarKey: string) {
    const image = await loadFirstProfileImage(labelAvatarKey.split('|').filter(Boolean))
    const node = this.avatars.get(pubkey)
    if (!node || node.labelAvatarKey !== labelAvatarKey || node.labelText !== label || !image) return
    this.replaceAvatarLabel(pubkey, label, image)
  }

  private avatarLabels(users: Map<string, MockUser>) {
    const labels = new Map<string, string>()
    if (!this.snapshot) return labels

    const positions = this.snapshot.positions.filter((position) => position.pubkey !== this.snapshot?.selfPubkey)
    const clustered = new Set<string>()

    positions.forEach((position) => {
      if (clustered.has(position.pubkey)) return
      const cluster = positions.filter(
        (candidate) =>
          !clustered.has(candidate.pubkey) &&
          Math.hypot(candidate.x - position.x, candidate.y - position.y) < 34,
      )

      if (cluster.length <= 1) {
        labels.set(position.pubkey, this.labelFor(position, users.get(position.pubkey)))
        clustered.add(position.pubkey)
        return
      }

      cluster.forEach((candidate, index) => {
        clustered.add(candidate.pubkey)
        labels.set(candidate.pubkey, index === 0 ? `${cluster.length} plebs` : '')
      })
    })

    if (this.canPlaceSelf) labels.set(this.snapshot.selfPubkey, 'You')
    return labels
  }

  private labelFor(position: WorldPosition, user?: MockUser) {
    if (this.canPlaceSelf && position.pubkey === this.snapshot?.selfPubkey) return 'You'
    return user?.name ?? 'npub'
  }
}

export function OfficeRenderer({ snapshot, onMove, canPlaceSelf = true }: OfficeRendererProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<ThreeOffice | null>(null)
  const initialSnapshotRef = useRef(snapshot)
  const initialMoveRef = useRef(onMove)
  const initialCanPlaceSelfRef = useRef(canPlaceSelf)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const office = new ThreeOffice(host, initialMoveRef.current, initialCanPlaceSelfRef.current)
    rendererRef.current = office
    office.applySnapshot(initialSnapshotRef.current)
    return () => {
      office.dispose()
      rendererRef.current = null
    }
  }, [])

  useEffect(() => {
    rendererRef.current?.setMoveHandler(onMove)
  }, [onMove])

  useEffect(() => {
    rendererRef.current?.setCanPlaceSelf(canPlaceSelf)
  }, [canPlaceSelf])

  useEffect(() => {
    rendererRef.current?.applySnapshot(snapshot)
  }, [snapshot])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const update = () => setSize({ width: host.clientWidth, height: host.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={hostRef} className="office-canvas" data-testid="office-canvas">
      <EdgePresenceOverlay
        snapshot={snapshot}
        size={size}
        canMove={canPlaceSelf}
        onMoveTo={(position) => rendererRef.current?.moveSelfNear(position)}
      />
    </div>
  )
}

function EdgePresenceOverlay({
  snapshot,
  size,
  canMove,
  onMoveTo,
}: {
  snapshot: OfficeSceneSnapshot
  size: { width: number; height: number }
  canMove: boolean
  onMoveTo: (position: JumpTarget) => void
}) {
  const markers = useMemo(() => {
    const self = snapshot.positions.find((position) => position.pubkey === snapshot.selfPubkey)
    if (!self || size.width < 10 || size.height < 10) return []

    const aspect = size.width / size.height
    const viewHeight = size.width < 620 ? 22 : CAMERA_VIEW_HEIGHT
    const viewWidth = viewHeight * aspect
    const users = new Map(snapshot.users.map((user) => [user.pubkey, user]))
    const raw = snapshot.positions
      .filter((position) => position.pubkey !== snapshot.selfPubkey)
      .map((position) => {
        const dx = (position.x - self.x) * WORLD_SCALE
        const dy = (position.y - self.y) * WORLD_SCALE
        const visible = Math.abs(dx) < viewWidth / 2 - 1.8 && Math.abs(dy) < viewHeight / 2 - 1.8
        if (visible) return null

        const nx = dx / Math.max(viewWidth / 2, 1)
        const ny = dy / Math.max(viewHeight / 2, 1)
        const edgeScale = 0.86 / Math.max(Math.abs(nx), Math.abs(ny), 0.001)
        const left = Math.max(7, Math.min(93, 50 + nx * edgeScale * 50))
        const top = Math.max(8, Math.min(92, 50 + ny * edgeScale * 50))

        return {
          pubkeys: [position.pubkey],
          label: users.get(position.pubkey)?.name ?? 'npub',
          imageUrl: userProfileImageCandidates(users.get(position.pubkey))[0],
          x: position.x,
          y: position.y,
          left,
          top,
          angle: Math.atan2(ny, nx),
        }
      })
      .filter(Boolean) as Array<{
      pubkeys: string[]
      label: string
      imageUrl?: string
      x: number
      y: number
      left: number
      top: number
      angle: number
    }>

    const groups: typeof raw = []
    raw.forEach((marker) => {
      const existing = groups.find((group) => Math.hypot(group.left - marker.left, group.top - marker.top) < 12)
      if (!existing) {
        groups.push(marker)
        return
      }
      existing.pubkeys.push(...marker.pubkeys)
      existing.imageUrl = undefined
      existing.x = (existing.x + marker.x) / 2
      existing.y = (existing.y + marker.y) / 2
      existing.left = (existing.left + marker.left) / 2
      existing.top = (existing.top + marker.top) / 2
      existing.angle = Math.atan2(
        (Math.sin(existing.angle) + Math.sin(marker.angle)) / 2,
        (Math.cos(existing.angle) + Math.cos(marker.angle)) / 2,
      )
      existing.label = `${existing.pubkeys.length} plebs`
    })

    return groups
  }, [snapshot.positions, snapshot.selfPubkey, snapshot.users, size.height, size.width])

  if (markers.length === 0) return null

  return (
    <div className="edge-presence-layer">
      {markers.map((marker) => {
        const avatar = marker.pubkeys.length === 1 ? avatarFromPubkey(marker.pubkeys[0]) : null
        const style = {
          left: `${marker.left}%`,
          top: `${marker.top}%`,
          ['--edge-angle']: `${marker.angle}rad`,
          ...(avatar
            ? {
                '--avatar-body': avatar.body,
                '--avatar-trim': avatar.trim,
                '--avatar-skin': avatar.skin,
                '--avatar-hair': avatar.hair,
              }
            : {}),
        } as CSSProperties

        return (
          <button
            type="button"
            key={marker.pubkeys.join(':')}
            className="edge-presence-chip"
            style={style}
            disabled={!canMove}
            aria-label={`Move near ${marker.label}`}
            onClick={() => onMoveTo({ x: marker.x, y: marker.y })}
          >
            <span className="edge-presence-arrow" />
            {avatar && (
              <span className={`edge-presence-avatar ${marker.imageUrl ? 'has-image' : ''}`}>
                {marker.imageUrl && <img src={marker.imageUrl} alt="" referrerPolicy="no-referrer" />}
              </span>
            )}
            <span>{marker.label}</span>
          </button>
        )
      })}
    </div>
  )
}
