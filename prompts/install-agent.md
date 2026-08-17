# Paste to a coding agent

Use **today’s local date** (`date +%F`) if you write a run folder.
Never hardcode a date. Do not copy herdr-desk into the target repo.

## This machine (once)

Install the Herdr plugin duyet/herdr-desk.
Need Herdr + bun + gh. Prefer: herdr plugin install duyet/herdr-desk
If this checkout is already herdr-desk: herdr plugin link .
Then: herdr plugin action invoke herdr-desk.start
Then: herdr plugin action invoke herdr-desk.status
Stop. Do not add features.

## This repo only

Wire herdr-desk for the current repo. Keep it tiny.

1. herdr plugin install duyet/herdr-desk (or link if already cloned). Start the plugin.
2. If .herdr-desk.json is missing, add one: name = repo folder, one task id "issues",
   task "github-issues", agentName "<short>-desk", kind grok, maxChildren 3,
   stateDir ".herdr-desk/runs/issues", morning "0 7 * * *", nightly "0 22 * * *".
   Gitignore .herdr-desk/runs/*/
3. Do not add extraPrompt unless this repo already has special CI/deploy rules.
4. Open or leave this repo as a Herdr workspace so the plugin can pick it up.
5. Verify: herdr plugin action invoke herdr-desk.status
   Run folders use today's date automatically. Do not invent a date. Do not copy prompts here.
