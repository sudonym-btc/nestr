const STORAGE_KEY = 'nestr.failedImages.v1'
const MAX_FAILED_IMAGES = 400

const failedImages = new Set<string>()
let loaded = false

function storage() {
  return typeof window === 'undefined' ? undefined : window.sessionStorage
}

function loadFailedImages() {
  if (loaded) return
  loaded = true
  const store = storage()
  if (!store) return

  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return
    const values = JSON.parse(raw) as unknown
    if (Array.isArray(values)) {
      values
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .slice(0, MAX_FAILED_IMAGES)
        .forEach((value) => failedImages.add(value))
    }
  } catch {
    // Broken image memory is a best-effort console-noise reducer.
  }
}

function persistFailedImages() {
  const store = storage()
  if (!store) return

  try {
    store.setItem(STORAGE_KEY, JSON.stringify(Array.from(failedImages).slice(-MAX_FAILED_IMAGES)))
  } catch {
    // Ignore storage failures; images can still fall back visually.
  }
}

export function markImageFailed(url: string | undefined | null) {
  if (!url) return
  loadFailedImages()
  if (failedImages.has(url)) return
  failedImages.add(url)
  persistFailedImages()
}

export function isImageMarkedFailed(url: string | undefined | null) {
  if (!url) return false
  loadFailedImages()
  return failedImages.has(url)
}

export function filterFailedImages(urls: string[]) {
  loadFailedImages()
  return urls.filter((url) => !failedImages.has(url))
}
