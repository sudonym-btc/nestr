import type { NostrConnectStoredSession } from './signers'

const DB_NAME = 'nestr-secure-store'
const DB_VERSION = 1
const KEY_STORE = 'keys'
const RECORD_STORE = 'records'
const AES_KEY_ID = 'nostr-connect-aes'
const SESSION_ID = 'nostr-connect-session'

interface EncryptedRecord {
  version: 1
  iv: string
  ciphertext: string
  updatedAt: number
}

function hasSecureStorageSupport() {
  return Boolean(globalThis.indexedDB && globalThis.crypto?.subtle)
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE)
      if (!db.objectStoreNames.contains(RECORD_STORE)) db.createObjectStore(RECORD_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

async function getValue<T>(storeName: string, key: string) {
  const db = await openDb()
  try {
    const transaction = db.transaction(storeName, 'readonly')
    const value = await requestResult<T | undefined>(transaction.objectStore(storeName).get(key))
    return value
  } finally {
    db.close()
  }
}

async function putValue(storeName: string, key: string, value: unknown) {
  const db = await openDb()
  try {
    const transaction = db.transaction(storeName, 'readwrite')
    await requestResult(transaction.objectStore(storeName).put(value, key))
  } finally {
    db.close()
  }
}

async function deleteValue(storeName: string, key: string) {
  const db = await openDb()
  try {
    const transaction = db.transaction(storeName, 'readwrite')
    await requestResult(transaction.objectStore(storeName).delete(key))
  } finally {
    db.close()
  }
}

async function getOrCreateAesKey() {
  const existing = await getValue<CryptoKey>(KEY_STORE, AES_KEY_ID)
  if (existing) return existing

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  await putValue(KEY_STORE, AES_KEY_ID, key)
  return key
}

export async function writeStoredNostrConnectSession(session: NostrConnectStoredSession) {
  if (!hasSecureStorageSupport()) return false

  const key = await getOrCreateAesKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(session))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
  const record: EncryptedRecord = {
    version: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    updatedAt: Date.now(),
  }

  await putValue(RECORD_STORE, SESSION_ID, record)
  return true
}

export async function readStoredNostrConnectSession() {
  if (!hasSecureStorageSupport()) return null

  const record = await getValue<EncryptedRecord>(RECORD_STORE, SESSION_ID)
  if (!record) return null

  const key = await getOrCreateAesKey()
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
    key,
    base64ToBytes(record.ciphertext),
  )

  return JSON.parse(new TextDecoder().decode(plaintext)) as NostrConnectStoredSession
}

export async function clearStoredNostrConnectSession() {
  if (!hasSecureStorageSupport()) return false

  await deleteValue(RECORD_STORE, SESSION_ID)
  return true
}
