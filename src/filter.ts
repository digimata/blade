/**
 * The inbound gate. Pure, so it can be tested without a Slack connection.
 *
 * Every rejection here is load-bearing: the bot checks stop agent-to-agent
 * loops, and the sender check is the only thing standing between a Slack
 * channel and prompt injection of this session.
 */

export type Access = {
  /** Slack member IDs whose messages may reach the session. */
  allowFrom: string[]
  /** If set, inbound is further restricted to these channels. */
  allowChannels?: string[]
  /** Channels Claude may post into unprompted. Separate from inbound: granting
   *  the right to speak somewhere must not change what we listen to. */
  postTo?: string[]
}

export type SlackMessage = {
  user?: string
  bot_id?: string
  subtype?: string
  channel?: string
  text?: string
}

/**
 * Slack redelivers any envelope not acked within 3 seconds, so inbound events
 * must be deduped on `event_id`. Neither the Discord nor the Telegram channel
 * needs this, so there is no upstream implementation to copy.
 */
export function makeDeduper(capacity = 1000) {
  const seen = new Set<string>()
  const order: string[] = []
  return (id: string | undefined): boolean => {
    if (!id) return false
    if (seen.has(id)) return true
    seen.add(id)
    order.push(id)
    if (order.length > capacity) seen.delete(order.shift()!)
    return false
  }
}

/**
 * Whether Claude may post into a channel.
 *
 * Two ways to earn it: the channel sent us an allowed message during this
 * process's lifetime, or it is named in `postTo`, a file only the operator can
 * write. The second is what permits unprompted posts.
 *
 * Injected text can therefore talk Claude into posting to a channel already on
 * the list, but not into one that isn't. That bound is the point.
 */
export function canPostTo(channel: string, seen: ReadonlySet<string>, access: Access): boolean {
  if (seen.has(channel)) return true
  return access.postTo?.includes(channel) ?? false
}

export function shouldForward(event: SlackMessage, access: Access, selfUserId: string): boolean {
  // Slack has no equivalent of Discord's `author.bot`, so this is three checks.
  if (event.bot_id) return false
  if (event.subtype === 'bot_message') return false
  if (event.user && event.user === selfUserId) return false
  // Edits, deletions, joins, topic changes. File shares carry real text.
  if (event.subtype && event.subtype !== 'file_share') return false
  // Gate on sender identity, never on channel: anyone in an allowed channel
  // could otherwise put text in front of Claude.
  if (!event.user || !access.allowFrom.includes(event.user)) return false
  if (access.allowChannels && !access.allowChannels.includes(event.channel ?? '')) return false
  return true
}
