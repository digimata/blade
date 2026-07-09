#!/usr/bin/env bun
/**
 * Drives slack.ts over stdio the way Claude Code does: initialize, then
 * tools/list. Asserts the channel capability is declared and `reply` exists.
 *
 * Run: bun run test:mcp
 */
import { join } from 'node:path'

const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'slack.ts')], {
  env: { ...process.env, BLADE_DRY_RUN: '1', BLADE_PERMISSION_RELAY: '1' },
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
})

const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`)

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harness', version: '0' } },
})
send({ jsonrpc: '2.0', method: 'notifications/initialized' })
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
await proc.stdin.flush()

const responses = new Map<number, any>()
const decoder = new TextDecoder()
let buffer = ''

for await (const bytes of proc.stdout) {
  buffer += decoder.decode(bytes)
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id) responses.set(msg.id, msg)
  }
  if (responses.has(1) && responses.has(2)) break
}
proc.kill()

const init = responses.get(1).result
const tools = responses.get(2).result.tools

const checks: [string, boolean][] = [
  ['server name is "slack"', init.serverInfo.name === 'slack'],
  ['declares claude/channel', 'claude/channel' in (init.capabilities.experimental ?? {})],
  ['declares claude/channel/permission', 'claude/channel/permission' in (init.capabilities.experimental ?? {})],
  ['declares tools capability', init.capabilities.tools !== undefined],
  ['instructions mention the reply tool', /reply tool/.test(init.instructions ?? '')],
  ['exposes exactly one tool', tools.length === 1],
  ['tool is named "reply"', tools[0]?.name === 'reply'],
  ['reply requires chat_id and text', JSON.stringify(tools[0]?.inputSchema.required) === '["chat_id","text"]'],
  ['reply accepts thread_ts', 'thread_ts' in tools[0]?.inputSchema.properties],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed++
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed === 0 ? 0 : 1)
