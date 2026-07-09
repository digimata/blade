/** Where tokens and the allowlist live, shared by the channel server and the CLI. */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Access } from './filter'

export const STATE_DIR =
  process.env.BLADE_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'blade-slack')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const ENV_FILE = join(STATE_DIR, '.env')

export const warn = (...msg: unknown[]) => process.stderr.write(`[blade] ${msg.map(String).join(' ')}\n`)

/**
 * Read tokens from the state dir so they never have to live in ~/.claude.json.
 * A real environment variable always wins, which keeps one-off runs simple.
 */
export function loadEnvFile(path = ENV_FILE) {
  let raw: string
  try {
    // The file holds credentials. Lock it to the owner rather than warning
    // about it. No-op on Windows, which would need ACLs.
    chmodSync(path, 0o600)
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!(key in process.env)) process.env[key] = value
  }
}

/** Re-read per message so edits take effect without restarting the session. */
export function loadAccess(): Access {
  try {
    const raw = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
    return { allowFrom: raw.allowFrom ?? [], allowChannels: raw.allowChannels, postTo: raw.postTo }
  } catch {
    return { allowFrom: [] }
  }
}

export function saveAccess(access: Access) {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${ACCESS_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 })
  // Rename is atomic, so a crash mid-write cannot leave a truncated allowlist.
  renameSync(tmp, ACCESS_FILE)
}
