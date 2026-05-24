type DebugDetails = Record<string, unknown>

function nowLabel() {
  return new Date().toISOString().slice(11, 23)
}

export function debugLog(scope: string, message: string, details?: DebugDetails) {
  const prefix = `[Nestr:${scope}] ${nowLabel()} ${message}`
  if (details) console.log(prefix, details)
  else console.log(prefix)
}

export function debugWarn(scope: string, message: string, details?: DebugDetails) {
  const prefix = `[Nestr:${scope}] ${nowLabel()} ${message}`
  if (details) console.warn(prefix, details)
  else console.warn(prefix)
}

export function debugError(scope: string, message: string, details?: DebugDetails) {
  const prefix = `[Nestr:${scope}] ${nowLabel()} ${message}`
  if (details) console.error(prefix, details)
  else console.error(prefix)
}

export function debugDuration(startedAt: number) {
  return Math.round(performance.now() - startedAt)
}

export function shortId(value: string | undefined) {
  return value ? `${value.slice(0, 8)}...${value.slice(-4)}` : undefined
}

export function eventTagSummary(tags: string[][]) {
  return tags
    .filter((tag) => ['d', 'e', 'h', 'p', 'relay', 'expiration', 'client'].includes(tag[0]))
    .map((tag) => tag.slice(0, 3))
}

export function contentSummary(kind: number, content: string) {
  if (kind === 25029 && content) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      return {
        sentAt: parsed.sentAt,
        startPos: parsed.startPos,
        endPos: parsed.endPos,
        speed: parsed.speed,
      }
    } catch {
      return { bytes: content.length, parse: 'failed' }
    }
  }

  return { bytes: content.length }
}
