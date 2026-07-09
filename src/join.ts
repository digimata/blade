#!/usr/bin/env bun
/**
 * Join a public Slack channel and grant Claude the right to post in it.
 *
 * Usage: bun src/join.ts [--list] [--no-post] <#channel|name|C0123ABC>
 *
 * Slack has no API to self-join a private channel, so those still need an
 * `/invite @blade` from someone already inside. Everything else is here.
 */
import { WebClient } from '@slack/web-api'
import { loadAccess, loadEnvFile, saveAccess, STATE_DIR, warn } from './state'

loadEnvFile()

const botToken = process.env.SLACK_BOT_TOKEN
if (!botToken) {
  warn(`SLACK_BOT_TOKEN not set and not found in ${STATE_DIR}/.env`)
  process.exit(1)
}

const args = process.argv.slice(2)
const list = args.includes('--list')
const grantPost = !args.includes('--no-post')
const target = args.find(a => !a.startsWith('--'))

const web = new WebClient(botToken)

type Channel = { id?: string; name?: string; is_private?: boolean; is_member?: boolean }

/** Walks the cursor; a workspace with many channels will not fit in one page. */
async function allChannels(): Promise<Channel[]> {
  const out: Channel[] = []
  let cursor: string | undefined
  do {
    const res = await web.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    })
    out.push(...((res.channels ?? []) as Channel[]))
    cursor = res.response_metadata?.next_cursor || undefined
  } while (cursor)
  return out
}

/** Slack's SDK throws a stack trace at the terminal; say what to do instead. */
function explain(e: unknown): never {
  const code = (e as { data?: { error?: string; needed?: string } })?.data
  if (code?.error === 'missing_scope') {
    warn(`this token lacks ${code.needed}.`)
    warn('The app was installed before blade needed them. At api.slack.com/apps:')
    warn('  OAuth & Permissions → add the bot scopes → Reinstall to Workspace')
    warn('Then update the bot token in the .env, since reinstalling reissues it.')
  } else if (code?.error) {
    warn(`slack: ${code.error}`)
  } else {
    warn(String(e))
  }
  process.exit(1)
}

const channels = await allChannels().catch(explain)

if (list || !target) {
  const rows = channels
    .slice()
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    .map(c => `${c.is_member ? '*' : ' '} ${c.id?.padEnd(12)} ${c.is_private ? 'private' : 'public '}  #${c.name}`)
  console.log(rows.join('\n'))
  console.log(`\n${channels.length} channels; * = blade is a member`)
  if (!target) process.exit(list ? 0 : 1)
}

const wanted = target!.replace(/^#/, '')
const match = channels.find(c => c.id === wanted || c.name === wanted)
if (!match?.id) {
  warn(`no channel named "${wanted}". Run with --list to see them.`)
  process.exit(1)
}

if (match.is_member) {
  console.log(`already a member of #${match.name} (${match.id})`)
} else if (match.is_private) {
  // conversations.join is public-only. Slack provides no way in from outside.
  warn(`#${match.name} is private. Someone inside must run: /invite @blade`)
  process.exit(1)
} else {
  await web.conversations.join({ channel: match.id }).catch(explain)
  console.log(`joined #${match.name} (${match.id})`)
}

if (grantPost) {
  const access = loadAccess()
  const postTo = access.postTo ?? []
  if (postTo.includes(match.id)) {
    console.log(`#${match.name} already in postTo`)
  } else {
    saveAccess({ ...access, postTo: [...postTo, match.id] })
    console.log(`added ${match.id} to postTo — Claude may now post in #${match.name}`)
  }
}
