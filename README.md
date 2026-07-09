# blade

A Slack [channel](https://code.claude.com/docs/en/channels) for Claude Code. Slack messages push into a running local session; Claude answers in-thread through a `reply` tool. Unlike Claude in Slack, the work happens on your machine, against your files, in the session you already have open.

Anthropic ships Telegram, Discord, and iMessage channels. There is no Slack one. This is it.

## How it works

`src/slack.ts` is an MCP server that Claude Code spawns over stdio. It holds a Slack Socket Mode WebSocket, and when an allowlisted person posts, it emits a `notifications/claude/channel` event. That lands in Claude's context as:

```
<channel source="slack" chat_id="C123" thread_ts="1699..." user_name="ross">deploy is red on main</channel>
```

Claude reads it, works, and calls `reply` to answer in the same thread.

## Setup

Creating the app cannot be scripted. Slack has no API to mint an app-level token, and no API to complete the OAuth install — both are browser actions. `manifest.json` removes everything else, so this is a paste and two clicks.

1. **Create the app from the manifest.** At [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**. Pick the workspace, paste the contents of `manifest.json`, create. That sets Socket Mode, the bot user, the four scopes, and the three event subscriptions — no checkboxes.
2. **Generate the app-level token.** **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**. Name it anything, add the `connections:write` scope. That's your `SLACK_APP_TOKEN` (starts `xapp-`). It is shown once.
3. **Install to the workspace.** **Install App** → **Install to Workspace** → Allow. Copy the **Bot User OAuth Token**. That's your `SLACK_BOT_TOKEN` (starts `xoxb-`).
4. **Add the bot to a channel.** For public channels blade joins itself, and grants Claude the right to post there. Do this after step 6, since it needs the token:

```sh
bun run join --list         # every channel; * marks the ones blade is in
bun run join engineering    # join #engineering, add it to postTo
bun run join eng --no-post  # join without granting posting rights
```

Private channels are the exception: Slack has no API to self-join one, so someone inside must `/invite @blade`.
One Slack app per person.** Socket Mode distributes events across open connections rather than broadcasting to all of them, so two people sharing one app token would each receive a random half of the messages. That failure presents as intermittent, not obvious.
5. **Allowlist yourself.** Find your Slack member ID (profile → ⋮ → Copy member ID; it looks like `U01ABCDEF`).

```sh
mkdir -p ~/.claude/channels/blade-slack
cat > ~/.claude/channels/blade-slack/access.json <<'EOF'
{ "allowFrom": ["U01ABCDEF"] }
EOF
```

It is re-read on every message, so edits take effect without restarting the session.

**6. Store the tokens.** They go in the state dir, never in `~/.claude.json`:

```sh
cat > ~/.claude/channels/blade-slack/.env <<'EOF'
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
EOF
```

The server `chmod 600`s this file on every read. A real environment variable of the same name always wins, which keeps one-off runs simple.

**7. Register the MCP server.** Add to `~/.claude.json` so it resolves from any project (absolute path required). No secrets here:

```json
{
  "mcpServers": {
    "slack": {
      "command": "bun",
      "args": ["/Users/you/Documents/digimata/projects/.misc/blade/src/slack.ts"]
    }
  }
}
```

**8. Run.** Custom channels are not on Anthropic's curated allowlist, so the development flag is required:

```sh
claude --dangerously-load-development-channels server:slack
```

A dim notice under the banner confirms it registered. Post in the channel; it arrives in your session.

## Multiple workspaces

Bot tokens are workspace-scoped, so covering two workspaces means two Slack apps and two channel servers. Give each its own name and state directory:

```json
{
  "mcpServers": {
    "slack-acme": {
      "command": "bun",
      "args": ["/abs/path/blade/src/slack.ts"],
      "env": {
        "BLADE_CHANNEL_NAME": "slack-acme",
        "BLADE_STATE_DIR": "/Users/you/.claude/channels/blade-slack-acme"
      }
    },
    "slack-globex": {
      "command": "bun",
      "args": ["/abs/path/blade/src/slack.ts"],
      "env": {
        "BLADE_CHANNEL_NAME": "slack-globex",
        "BLADE_STATE_DIR": "/Users/you/.claude/channels/blade-slack-globex"
      }
    }
  }
}
```

Each state dir holds its own `.env` and `access.json`. Your member ID differs per workspace, so each `access.json` needs the ID from that workspace. Run both in one session:

```sh
claude --dangerously-load-development-channels server:slack-acme server:slack-globex
```

Messages then arrive tagged `source="slack-acme"` or `source="slack-globex"`, and every event carries a `team` attribute naming the workspace. Without distinct `BLADE_CHANNEL_NAME` values both servers announce themselves as `slack` and Claude cannot tell the workspaces apart.

## Access control

`access.json` gates **senders**, not channels:

| Key | Direction | Meaning |
|---|---|---|
| `allowFrom` | inbound | Slack member IDs permitted to reach the session. Required; empty admits nobody. |
| `allowChannels` | inbound | Optional. If set, messages are additionally restricted to these channel IDs. |
| `postTo` | outbound | Optional. Channels Claude may post into unprompted. |

Gating on channel alone would mean anyone who can be added to that channel can put text in front of Claude. Message content is untrusted input — treat it as data, never as instructions about who may access the session.

Outbound is gated separately. `reply` posts only to a channel that sent an allowed message during this process's lifetime, or one named in `postTo`. Without `postTo`, Claude is strictly reactive: it can answer, never initiate.

`postTo` is what lets Claude message a channel on its own — a build result, a heads-up when a long job finishes. The tradeoff is real: once a channel is on the list, text arriving from Slack could talk Claude into posting there. It cannot reach any channel off the list, and that bound is the point.

The two lists are deliberately separate. Granting the right to speak somewhere must not change what the session listens to.

## Permission relay

Off by default. Set `BLADE_PERMISSION_RELAY=1` and Claude's tool-approval prompts are forwarded to the last active Slack thread, where you answer `yes <id>` or `no <id>`. The terminal dialog stays open; whichever answer lands first wins.

**Anyone on `allowFrom` can then approve tool calls in your session.** Only allowlist people you would hand your terminal to.

## Development

```sh
bun test           # the inbound gate: loop prevention, sender gate, dedup
bun run test:mcp   # MCP handshake: capability declaration, tool schema
```

```
src/slack.ts         the channel server: Socket Mode in, MCP notifications out
src/filter.ts        the inbound gate, pure so it can be tested without Slack
test/filter.test.ts  loop prevention, sender gate, dedup
test/test-mcp.ts     drives the server over stdio the way Claude Code does
manifest.json        paste into Slack to create the app
```

`BLADE_DRY_RUN=1` serves the MCP surface without connecting to Slack.

Diagnostics go to stderr, never stdout — stdout is the MCP transport, and a stray `console.log` corrupts the protocol stream. The Slack SDK's default logger writes to stdout, which is why one is injected.

## Notes

Slack redelivers any envelope not acked within 3 seconds, so events are acked on receipt and deduped on `event_id`. The Discord and Telegram channels need neither, so there was no reference implementation to copy.

Bot messages are dropped three ways: `bot_id`, `subtype === 'bot_message'`, and sender equal to our own bot user. Slack has no equivalent of Discord's single `author.bot` boolean. Without all three, two agents in one channel answer each other until the tokens run out.

Channels are a research preview. The `--channels` flag syntax and the protocol contract may change.
