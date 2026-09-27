# Paste to a coding agent: update herdr-desk

Bring an installed herdr-desk up to date, and check whether it still matches
its config.

There is **no `herdr plugin update`** in Herdr v1. Reinstalling is the only
upgrade path, so do not go looking for a subcommand that does not exist.

## 1. Establish what is installed

```sh
herdr plugin list --json
```

Read the `herdr-desk` entry and note:

- `source.kind` — `github` or `local`
- `source.owner` / `source.subdir` — the origin, e.g. `duyet/herdr-desk`
- `source.requested_ref` — a pin, if the user set one
- `plugin_root`, `manifest_path`, `version`

**If `source.kind` is `local`, stop.** That is a linked working tree; the user
owns it and it is not ours to rewrite. Say so and exit. Do not install over it —
Herdr refuses that anyway.

## 2. Check for a newer version

```sh
herdr plugin install <owner>/<repo> --help   # confirm reinstall semantics
git -C <plugin_root> fetch origin
git -C <plugin_root> log --oneline HEAD..@{u}
```

- Behind by nothing → already current. Report the version and stop.
- Behind → show what changed before doing anything:
  `git -C <plugin_root> log --oneline @{u}..HEAD` is the wrong direction; use
  `git -C <plugin_root> log --oneline HEAD..@{u}` for what is new.
- A `requested_ref` pin means the user chose a version. **Do not move them off
  it silently.** Report that a newer version exists and let them decide.

## 3. Upgrade, in this order

```sh
herdr plugin action invoke herdr-desk.stop
herdr plugin install <owner>/<repo> --yes
herdr plugin action invoke herdr-desk.start
herdr plugin action invoke herdr-desk.status
```

Stop first, then install, then start. Installing over a running daemon leaves
the old process reading files that are being replaced underneath it.

`--yes` is correct here: the user asked to upgrade, and this is the documented
non-interactive path. The install preview that a human sees on first install is
still the right thing to have shown them once, at first install.

## 4. Config and state survive

Say this explicitly, because it is the usual worry:

- config lives in `herdr plugin config-dir herdr-desk`
- state lives in `~/.local/state/herdr/plugins/herdr-desk/`

Neither is inside `plugin_root`, so reinstalling replaces the checkout and
nothing else. `runs.jsonl`, `fires.json`, `known-repos.json` and `config.json`
are untouched.

## 5. Migrate the config, if the release needs it

The only rename so far is `kind` → `agent`, and it is backward compatible:
`kind` is still read. So a 0.1.x config needs no change.

To move it forward deliberately:

```sh
bun src/cli.ts config explain --repo <repo>    # what resolves today
```

Then, only if the user wants it, rewrite `kind` as `agent` in their config.
`desk migrate` is not implemented yet — do not invent the command. Edit the
file directly, and keep the change to that one field.

Rules for touching their config:

- One field at a time, then re-run `config explain` to confirm.
- Never put a secret in a repo config. `notify` targets reference credentials as
  `${VAR}`; the real value belongs in the machine config, `0600`.
- If `config explain` shows a value coming from an unexpected layer, report it.
  Do not paper over a layering bug by pinning the field locally.

## 6. Check the machine still works

```sh
herdr plugin action invoke herdr-desk.validate
bun src/cli.ts status
bun src/cli.ts config explain --repo <repo> --tasks
```

- `validate` must report 0 errors.
- `status` must show a `next` fire for every job. A `-` means the cron can never
  match, which is a config bug worth fixing now.
- If an agent rung is not installed, the desk skips it and escalates. Check
  `herdr integration status` and offer to install what they actually use.

## 7. Report

- Old version → new version, or "already current"
- Whether the upgrade replaced a managed checkout
- Any config field you changed, one line each
- Anything that validated but looks wrong

Do not add features while upgrading. If you notice something unrelated that
needs fixing, say so and let the user decide.
