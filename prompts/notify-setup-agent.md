# Paste to a coding agent: set up desk notices on this machine

Point this machine's herdr desks at the shared Telegram channel, and confirm
delivery. The same setup runs on every box, so the channel can tell which
machine and which repo each notice came from.

## 0. Credentials — the one thing you must NOT improvise

**The bot token is a live credential. Never write it into any file in a git
repo, never echo it to the terminal, never put it in a commit message, a test
fixture, or a log.**

If this conversation has not already given you a token, **stop and ask the user
for it.** Do not invent one, do not look for one in a repo, and do not reuse a
token from another machine's config without asking.

Two acceptable homes for it:

| Where | When |
|---|---|
| `notify.json` in the plugin config dir (`chmod 600`) | normal case, a long-lived daemon |
| `HERDR_DESK_TELEGRAM_TOKEN` | CI, or a throwaway shell |

Prefer the file. It survives reboots and is not inherited by unrelated
processes.

If a token ever ends up somewhere it should not — a repo file, a commit, a log,
a pasted transcript — **say so loudly and immediately.** Do not quietly fix it
and move on. A leaked bot token gets revoked and used to send spam as the
user; the honest, fast path is to tell them and have them rotate it with
@BotFather (`/revoke`).

## 1. Prerequisites

```sh
herdr --version        # 0.9+
herdr plugin list      # is herdr-desk installed?
```

If it is not installed, install or link it first (`docs/setup.md` covers this),
then come back. Do not configure notices for a plugin that is not there.

## 2. Get the chat id right

This is the step people get wrong, so verify it rather than assuming.

**The bot's own id is not the chat id.** @BotFather shows the *bot's* numeric id
when you create a bot. Sending to that id fails with:

```
403 Forbidden: the bot can't send messages to the bot
```

If you see that, the destination is the bot itself. The fix is always the same:

1. the user opens Telegram, finds the bot, and **sends it any message**
2. the bot can then read that conversation and learn the real chat id

Check what is available, without printing any token:

```sh
bun src/cli.ts notify "probe" --repo "$PWD" --label desk:github-issues
```

- `sent [...]` → working, stop
- `HTTP 403` → wrong chat id, or the bot was never contacted. Ask the user to
  message the bot, then re-run
- `not configured` → go to step 3

## 3. Write the host config

```sh
CFG="$(herdr plugin config-dir herdr-desk)"
mkdir -p "$CFG"
```

Create `$CFG/notify.json`. Ask the user for the token; do not guess it.

```json
{
  "token": "<paste from the user>",
  "chatId": "<the real chat id>"
}
```

Then lock it down and confirm without echoing the secret:

```sh
chmod 600 "$CFG/notify.json"
python3 -c "import json,os,stat,sys;p=sys.argv[1];d=json.load(open(p));m=stat.S_IMODE(os.stat(p).st_mode);print('mode',oct(m),'| token set',bool(d.get('token')),'len',len(d.get('token','')),'| chatId',d.get('chatId'))" "$CFG/notify.json"
```

`mode 0o600` and a plausible token length (a real one is ~46 chars) is the
confirmation. Never `cat` the file.

Optional: `"topicId": "7"` for a Telegram forum topic, and `"enabled": false` to
mute without deleting the token.

## 4. Confirm delivery

```sh
bun src/cli.ts notify "setup check on $(hostname -s)" --repo "$PWD" --label desk:github-issues
```

Then **ask the user to confirm they received it.** A 200 from Telegram only
proves the API accepted the message, not that a human can see it.

## 5. Per-desk channels

Only if the user asks. Some repos need a dedicated channel; the default applies
to everything else.

```json
{
  "name": "anyrouter",
  "notify": { "chatId": "-1004420104760", "topicId": "7" }
}
```

Rules to state out loud:

- **destination only.** A repo config may never set `token`. `.herdr-desk.json`
  is committed, and `validate` treats a `token` there as a hard error on purpose.
- precedence is **task → repo → group → host default**
- `enabled` only ever narrows; a repo cannot un-mute what the host muted
- check what resolved with:
  ```sh
  bun src/cli.ts config explain --repo DIR
  ```

For a whole tree of repos, put the override in the group config above them
(`"group": true`) rather than editing each repo.

## 6. Check notices actually fire

Notices are sent when a run **finishes** — spawned, re-prompted, skipped, or
failed. They are not sent when the cron fires.

```sh
bun src/cli.ts run desk:github-issues --repo <repo>   # forces a real run
```

This is a real maintenance run. Ask the user first, and do not do it on a repo
where a run is not wanted.

## 7. Report back

State plainly:

- whether a test message was sent, and whether the user confirmed receipt
- which chat id is configured, and how you established it
- where the token lives, and that it is not in any repo
- every repo with a per-desk override
- anything you could not verify

If the token was pasted in this conversation, say once more that it is now in a
transcript and should be rotated. Do not bury it.
