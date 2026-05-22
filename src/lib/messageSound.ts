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
