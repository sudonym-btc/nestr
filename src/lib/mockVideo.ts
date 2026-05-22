import { avatarFromPubkey } from './avatar'

export interface MockPeerVideo {
  pubkey: string
  name: string
  stream: MediaStream
  stop: () => void
}

function colorToRgb(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16)
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  }
}

export function createMockPeerVideo(pubkey: string, name: string): MockPeerVideo {
  const avatar = avatarFromPubkey(pubkey)
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const context = canvas.getContext('2d')
  const body = colorToRgb(avatar.body)
  const trim = colorToRgb(avatar.trim)
  let raf = 0
  let frame = 0

  const draw = () => {
    if (!context) return
    frame += 1
    const pulse = Math.sin(frame / 18)
    const sweep = (frame * 3) % canvas.width

    context.fillStyle = `rgb(${Math.max(14, body.r - 70)}, ${Math.max(18, body.g - 70)}, ${Math.max(24, body.b - 70)})`
    context.fillRect(0, 0, canvas.width, canvas.height)

    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height)
    gradient.addColorStop(0, `rgba(${body.r}, ${body.g}, ${body.b}, 0.76)`)
    gradient.addColorStop(1, `rgba(${trim.r}, ${trim.g}, ${trim.b}, 0.62)`)
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)

    context.fillStyle = 'rgba(255,255,255,0.12)'
    for (let index = 0; index < 7; index += 1) {
      const x = (sweep + index * 116) % (canvas.width + 160) - 80
      context.beginPath()
      context.ellipse(x, 92 + index * 22, 94 + pulse * 12, 18, -0.18, 0, Math.PI * 2)
      context.fill()
    }

    context.fillStyle = 'rgba(0,0,0,0.22)'
    context.fillRect(0, canvas.height - 78, canvas.width, 78)
    context.fillStyle = '#ffffff'
    context.font = '700 28px Inter, system-ui, sans-serif'
    context.fillText(name, 28, canvas.height - 32)
    context.font = '600 14px ui-monospace, monospace'
    context.fillText(`mock WebRTC stream · ${avatar.badge}`, 30, 36)

    context.fillStyle = avatar.skin
    context.beginPath()
    context.arc(canvas.width - 72, 78 + pulse * 4, 32, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = avatar.hair
    context.fillRect(canvas.width - 104, 42 + pulse * 4, 64, 18)

    raf = window.requestAnimationFrame(draw)
  }

  draw()
  const stream = 'captureStream' in canvas ? canvas.captureStream(24) : new MediaStream()

  return {
    pubkey,
    name,
    stream,
    stop: () => {
      window.cancelAnimationFrame(raf)
      stream.getTracks().forEach((track) => track.stop())
    },
  }
}
