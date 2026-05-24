let audioContext: AudioContext | null = null

function getAudioContext() {
  const AudioCtor = window.AudioContext ?? window.webkitAudioContext
  if (!AudioCtor) return null
  audioContext ??= new AudioCtor()
  return audioContext
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}

export async function primeMessageSound() {
  const context = getAudioContext()
  if (!context || context.state !== 'suspended') return
  try {
    await context.resume()
  } catch {
    // Browsers may reject until a stronger user gesture; message playback is best-effort.
  }
}

export function playMessageSound() {
  const context = getAudioContext()
  if (!context || context.state === 'suspended') return

  const oscillator = context.createOscillator()
  const gain = context.createGain()
  const start = context.currentTime

  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(720, start)
  oscillator.frequency.exponentialRampToValueAtTime(980, start + 0.08)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(0.08, start + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16)

  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(start)
  oscillator.stop(start + 0.18)
}

export function playCallJoinSound() {
  const context = getAudioContext()
  if (!context || context.state === 'suspended') return

  const start = context.currentTime
  const gain = context.createGain()
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(0.065, start + 0.018)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34)
  gain.connect(context.destination)

  const tones = [440, 660]
  tones.forEach((frequency, index) => {
    const oscillator = context.createOscillator()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(frequency, start + index * 0.08)
    oscillator.connect(gain)
    oscillator.start(start + index * 0.08)
    oscillator.stop(start + 0.28 + index * 0.06)
  })
}
