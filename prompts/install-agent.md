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

Wire herdr-desk. Keep it tiny.

1. herdr plugin install duyet/herdr-desk (or link). Start the plugin.
2. If .herdr-desk.json is missing, write the minimal file that validates
   against https://raw.githubusercontent.com/duyet/herdr-desk/main/herdr-desk.schema.json
   ```
   { "$schema": "<that url>", "name": "<repo-folder>" }
   ```
   Defaults fill playbook, agent, 5 worktrees, 07:00 morning. No nightly.
   Only add extraPrompt if this repo has special rules — inline text, not
   a new extra.md, unless they already have a file.
3. Gitignore .herdr-desk/runs/*/
4. Leave this repo as a Herdr workspace.
5. herdr plugin action invoke herdr-desk.status
   Do not invent a date. Do not copy prompts here.
