# pi-claude-usage

A [pi](https://pi.dev) extension: show your Claude subscription usage (the
5-hour session limit and weekly limit from claude.ai's Settings > Usage page)
directly in the pi footer.

It reuses the OAuth token already stored on your machine by the `claude`
(Claude Code) CLI and polls Anthropic's usage endpoint every few minutes.

## Install

```bash
pi install git:github.com/inrd/pi-claude-usage@v0.1.0
```

Or try it for a single run without touching settings:

```bash
pi -e git:github.com/inrd/pi-claude-usage
```

Local checkout:

```bash
pi -e ./extensions/claude-usage.ts
```

## Requirements

- You've signed in at least once with the `claude` (Claude Code) CLI.
- **macOS**: the token is read from the `Claude Code-credentials` Keychain
  item.
- **Linux**: the token is read from `~/.claude/.credentials.json` (plaintext,
  written there by Claude Code when no OS keychain is available).
- Windows is not supported yet.

No credentials are stored or logged by this extension; the token is read at
call time and sent only to `api.anthropic.com`.

## Usage

The footer shows two bars whenever the active model is a Claude model
(`anthropic`/`claude-code` provider, or a model id containing `claude`):

```
5h ████░░░░ 42%   wk ██░░░░░░ 18%
```

Colors shift from dim to warning (≥70%) to error (≥90%). The status clears
when you switch to a non-Claude model.

| Command | |
|---|---|
| `/usage` | print current session and weekly usage, with reset times |

## Notes

- `/api/oauth/usage` is an undocumented endpoint used internally by Claude
  Code; it could change or go away without notice.
- The extension backs off on HTTP 429 using the `retry-after` header and
  keeps showing the last known values instead of clearing them.
- Polling interval is 3 minutes.

## Development

A single TypeScript file, loaded by pi directly — no build step. Point pi at
it while you work:

```bash
pi -e ./extensions/claude-usage.ts
```

After changing it, `/reload` in a running session picks it up.

Typecheck:

```bash
npm install
npm run typecheck
```

The Pi packages are dev dependencies pinned to the version the extension was
last checked against; bump them to catch API changes in newer Pi releases.
