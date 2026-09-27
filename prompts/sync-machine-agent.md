# Paste to a coding agent: bring this machine's desk up to date

Upgrade herdr-desk and align its behaviour with the other machines, so notices
from every box land in the same channel and read the same way.

## 1. Find out what is installed

```sh
herdr plugin list --json | jq '.result.plugins[] | select(.plugin_id=="herdr-desk")'
```

Read and report:

- `source.kind` — `github` or `local`
- `source.owner` / `source.subdir` — the origin
- `source.requested_ref` — a pin, if the user set one
- `plugin_root`, `version`

**If `source.kind` is `local`, stop.** That is a linked working tree, not a
managed install. The user owns it; do not reinstall over it. Report that and ask
what they want.

## 2. Check for a newer version

```sh
git -C <plugin_root> fetch origin
git -C <plugin_root> log --oneline HEAD..@{u}
```

- Nothing new → say "already current" and go to step 5
- Behind → **show the user what changed before installing.** Read the diff or
  the changelog; do not upgrade a plugin on a machine that runs unattended jobs
  without telling them what is about to change
- A `requested_ref` pin means the user chose a version. Report that a newer one
  exists and let them decide. Never move them off a pin silently

## 3. Upgrade, in this order

```sh
herdr plugin action invoke herdr-desk.stop
herdr plugin install <owner>/<repo> --yes
herdr plugin action invoke herdr-desk.start
herdr plugin action invoke herdr-desk.status
```

Stop → install → start. Installing over a running daemon leaves the old process
reading files that are being replaced underneath it.

Config and state live outside the plugin checkout, so nothing is lost:
`herdr plugin config-dir herdr-desk` holds `config.json` and `notify.json`, and
`~/.local/state/herdr/plugins/herdr-desk/` holds the ledger.

**Re-read `notify.json` after the upgrade and confirm it still exists.** A
machine that predates notices will not have one, and that is the whole point of
this prompt.

## 4. Align the notice destination

Every machine should report into the **same** chat. Check:

```sh
CFG="$(herdr plugin config-dir herdr-desk)"
python3 -c "import json,os,stat,sys;p=sys.argv[1];d=json.load(open(p));m=stat.S_IMODE(os.stat(p).st_mode);print('mode',oct(m),'| token set',bool(d.get('token')),'len',len(d.get('token','')),'| chatId',d.get('chatId'),'| topicId',d.get('topicId'))" "$CFG/notify.json"
```

Expect `mode 0o600`, a ~46-char token, and the shared `chatId`. Never `cat` the
file.

**If `notify.json` is missing or has no token, stop and ask the user for the
token.** Do not invent one, do not reuse a token from another machine's config
without permission, and do not read one out of a repo. The file is
`~/.config/herdr/plugins/herdr-desk/notify.json`, `chmod 600`.

If a token was pasted into this conversation, say plainly that it is now in a
transcript and should be rotated with @BotFather. Do not bury that.

Then confirm delivery, and **ask the user to confirm they received it** — a 200
from Telegram only proves the API accepted the message.

```sh
bun src/cli.ts notify "desk upgraded on $(hostname -s)" --repo "$PWD" --label desk:github-issues
```

Two things to get right if delivery fails:

- **`403 Forbidden: the bot can't send messages to the bot`** means the chat id
  is the bot's own id, not a chat. @BotFather shows the *bot's* numeric id. A bot
  cannot DM anyone first: the user must message it once in Telegram, and then the
  real chat id can be read from `getUpdates`
- **`not configured`** means step 4 did not run. Fix it, do not work around it

## 5. Align per-desk destinations

Repos that need a dedicated channel should say so in their own config, not in
this machine's host file:

```json
{ "name": "anyrouter", "notify": { "chatId": "-100…", "topicId": "7" } }
```

Rules worth restating:

- **destination only** — a repo config may never set `token`, because
  `.herdr-desk.json` is committed and `validate` treats a `token` there as a
  hard error on purpose
- precedence is **task → repo → group → host default**
- `enabled` only narrows; a repo cannot un-mute what the host muted
- if the destination is a forum, `topicId` is the topic's `message_thread_id`
  and omitting it posts to General

Verify what actually resolved:

```sh
bun src/cli.ts config explain --repo <repo>
```

If a value comes from a layer the user did not expect, report it. Do not paper
over a layering surprise by pinning the field locally.

## 6. Check the machine is healthy

```sh
herdr plugin action invoke herdr-desk.validate
bun src/cli.ts status
```

- `validate` must report 0 errors
- `status` must show a `next` fire for every job. A `-` means the cron can never
  match, which is a config bug worth fixing now
- a job with a long failure streak is worth reporting; check
  `bun src/cli.ts history 40`

## 7. Report

- old version → new version, or "already current", and what the upgrade changed
- whether `notify.json` already existed or had to be created
- the chat id now configured, and how delivery was confirmed
- any repo whose notice destination is unusual
- anything you could not verify

Do not add features while upgrading. If something unrelated needs fixing, say
so and let the user decide.
