# Agent Toolbox

Self-hosted MCP-first tools for AI agents on SmallCloudInc.

Callable as MCP tools or a plain REST API, right from Claude Code, Codex, Cursor, OpenCode, Grok CLI, or any harness that speaks MCP or HTTP.

Sign up at [agent-toolbox.smallcloudinc.com](https://agent-toolbox.smallcloudinc.com)



https://github.com/user-attachments/assets/a6846cd4-9524-4a0a-8ca3-4e5464a02f30



## Tools

- **URL shortener** (`shorten_url`) — long URL in, short link out, with click tracking.
- **Pastebin** (`create_paste`) — share text/code snippets with a link. private, unlisted, or burn-after-read.
- **Mailbox** (`create_inbox`) — claim a real `handle@agent-toolbox.smallcloudinc.com` address. read OTPs and webhooks, send and receive, threaded replies. one per account.
- **Email me** (`email_me`) — email yourself right now, or schedule it for a future timestamp.
- **File sharing** (`create_file`) — get a one-time upload URL, PUT the raw file to it, get back a public link. up to 10MB, no base64 anywhere.

## Connect via MCP

`/authorize` opens a browser once and completes OAuth — no token to copy.

**Claude Code**

```bash
claude mcp add --transport http agent-toolbox https://agent-toolbox.smallcloudinc.com/mcp
```

**Grok CLI**

```bash
grok mcp add --transport http agent-toolbox https://agent-toolbox.smallcloudinc.com/mcp
```

**Codex CLI**

```bash
codex mcp add agent-toolbox --url https://agent-toolbox.smallcloudinc.com/mcp
codex mcp login agent-toolbox
```

**Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "agent-toolbox": { "url": "https://agent-toolbox.smallcloudinc.com/mcp" }
  }
}
```

**OpenCode**

```bash
opencode mcp add agent-toolbox --url https://agent-toolbox.smallcloudinc.com/mcp
opencode mcp auth agent-toolbox
```

### MCP tools

| Tool | Description |
| --- | --- |
| `shorten_url` | Create a short link for a URL |
| `list_links` | List your short links |
| `create_paste` | Create a paste (text snippet) and get a shareable link |
| `get_paste` | Fetch a paste's content by slug (works for your own private pastes too) |
| `list_pastes` | List your pastes |
| `create_inbox` | Claim your email address by picking a handle. One address per account |
| `send_email` | Send an email from one of your inbox addresses; thread replies via `replyToMessageId` |
| `list_inboxes` | List your email address(es) |
| `list_inbox_messages` | List messages received in an inbox |
| `get_inbox_message` | Fetch the full content of a received email |
| `email_me` | Email the account owner's own verified address, now or at a future time |
| `create_file` | Get a one-time upload URL (valid 10 min); PUT the raw file to it to finish. Max 10MB, no base64 |
| `list_files` | List your uploaded files |
| `delete_file` | Delete an uploaded file |

## REST API

Prefer plain HTTP? Sign up, verify, and use the API key as a bearer token.

```bash
curl -X POST https://agent-toolbox.smallcloudinc.com/v1/auth/signup -d '{"email":"you@example.com"}'
curl -X POST https://agent-toolbox.smallcloudinc.com/v1/auth/verify -d '{"email":"...","code":"123456"}'
# => {"apiKey":"hlt_live_..."}

curl -X POST https://agent-toolbox.smallcloudinc.com/v1/links -H "authorization: Bearer hlt_live_..." \
  -d '{"url":"https://example.com"}'
```

Uploading a file from disk? Send the raw bytes as the request body — never base64. If you already have an API key, do it in one call:

```bash
curl -T ./photo.png -H "authorization: Bearer hlt_live_..." \
  "https://agent-toolbox.smallcloudinc.com/v1/files?filename=photo.png"
```

No API key handy (e.g. an MCP-connected agent)? Two steps: request an upload URL, then PUT the file to it — the URL itself is the one-time credential, valid for 10 minutes:

```bash
curl -X POST https://agent-toolbox.smallcloudinc.com/v1/files -H "authorization: Bearer hlt_live_..." \
  -d '{"filename":"photo.png"}'
# => {"uploadUrl":"https://agent-toolbox.smallcloudinc.com/v1/files/upload/<token>","expiresAt":"..."}

curl -T ./photo.png "https://agent-toolbox.smallcloudinc.com/v1/files/upload/<token>"
```

| Resource | Endpoints |
| --- | --- |
| `/v1/auth` | `POST /signup`, `POST /verify`, `GET /keys`, `POST /keys`, `DELETE /keys/:id` |
| `/v1/links` | `POST /`, `GET /`, `GET /:slug`, `DELETE /:slug` |
| `/v1/pastes` | `POST /`, `GET /`, `GET /:slug`, `DELETE /:slug` |
| `/v1/inboxes` | `POST /`, `GET /`, `GET /:id`, `POST /:id/send`, `GET /:id/messages/:messageId`, `DELETE /:id` |
| `/v1/email-me` | `POST /` |
| `/v1/files` | `POST /` (mint an upload token), `PUT /upload/:token` (finish it), `PUT /` (one-shot raw upload with API key), `GET /`, `DELETE /:slug`. All uploads are raw bytes, max 10MB |

Short links resolve at the bare root (`agent-toolbox.smallcloudinc.com/:slug`), paste content is served raw at `/p/:slug`, and uploaded files at `/f/:slug`.

The homepage also returns a markdown rendition when requested with `Accept: text/markdown`, for agents that would rather not parse HTML.

### Limits and retry safety

- Links: 1,000 per account.
- Pastes: 500 per account, 1MB each.
- Files: 100 per account, 500MB total, 10MB each. Upload URLs expire after 10 minutes and can be used only once.
- Email: 100 outbound messages per UTC day and 256KB of text/HTML per message.
- Inbox: 1,000 inbound messages and 250MB of raw mail per inbox. Individual inbound messages are capped at 5MB and messages are retained for 30 days.

For `POST /v1/inboxes/:id/send` and `POST /v1/email-me`, send a stable `Idempotency-Key` header (8–128 URL-safe characters) when retrying. The MCP `send_email` and `email_me` tools accept the same value as `idempotencyKey`.

Uploaded HTML, SVG, and other active content is served as a download. Only a small allowlist of inert image formats and plain text is displayed inline.

## Stack

- [Hono](https://hono.dev/) on [Cloudflare Workers](https://developers.cloudflare.com/workers/) — REST API, MCP server, and the server-rendered (Hono JSX) landing page
- [Drizzle ORM](https://orm.drizzle.team/) over [D1](https://developers.cloudflare.com/d1/)
- [R2](https://developers.cloudflare.com/r2/) for uploaded files
- [Workers KV](https://developers.cloudflare.com/kv/) for OAuth state
- [Email Service](https://developers.cloudflare.com/email-service/) for the mailbox and reminders
- [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) for MCP OAuth
- [Shiki](https://shiki.style/) for the syntax-highlighted docs blocks
- Tailwind CSS v4

## Development

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs on the Cloudflare Vite plugin, which emulates the bindings declared in `wrangler.json` (D1, R2, KV, Email, rate limits) locally.

Apply migrations locally:

```bash
pnpm db:migrate:local
```

After changing `src/db/schema.ts`, generate a new migration:

```bash
pnpm db:generate
```

`wrangler.json` is bound to the SmallCloudInc Cloudflare account (`account_id` `3c445f673c4e1e5dcca897aa7f6c3c30`) and the `agent-toolbox.smallcloudinc.com` custom domain. Worker name is `agent-toolbox`, D1 is `agent-toolbox-db` (`c0073068-0bc4-4e9d-b850-37f89f0b0733`), R2 is `agent-toolbox`, and `OAUTH_KV` is `9ae20284bb974819817fbe1b776c8430`. `INBOX_DOMAIN` is `agent-toolbox.smallcloudinc.com`.

## Deploy

```bash
pnpm db:migrate:remote
pnpm run build
pnpm run deploy
```

Apply D1 migrations before publishing a Worker version that depends on them. The migration is backward-compatible with the previous Worker, so this order avoids a schema/code mismatch during rollout.

`pnpm run check` type-checks, builds, and does a dry-run deploy without publishing.
