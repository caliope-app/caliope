# Caliope

An open-source alternative to the GitHub Copilot app, for Windows. It works in your project, on your own Copilot plan.

## Why Caliope

- **Faster, at less than half the cost.** Than the GitHub Copilot app, on browser-heavy work with the same model ([the test](https://caliope.be/docs.html#app-comparison)).
- **Watch it work.** The agent's browser runs right next to the chat. Take over whenever you want.
- **Actually stays signed in.** Logins last across sessions and restarts, separate per project. The Copilot app's browser loses them ([known issue](https://github.com/github/app/issues/4201)).
- **Every cost in sight.** Each request, session and model, in dollars or AI credits. Set a monthly limit per project.
- **No admin rights.** It installs for your Windows account only and works behind a company proxy.

## What it does

- Reads your code, edits files, runs commands and tests.
- Opens pull requests on GitHub and Azure DevOps.
- Runs any model in your Copilot plan: Claude, GPT, Gemini. The newest Claude Opus by default.
- You choose what it may do without asking: nothing, everything, or all but risky actions (Auto).
- Subagents, MCP servers, skills, memory and scheduled tasks.

## Install

Paste this into PowerShell:

```powershell
irm https://github.com/caliope-app/caliope/releases/latest/download/install.ps1 | iex
```

- Needs 64-bit Windows 10 or 11, Chrome or Edge, and a Copilot plan (Pro, Pro+, Business or Enterprise). The Changes panel, commits, pull requests and worktrees also need git.
- Line blocked? Download `Caliope-windows-x64.zip` from the [latest release](https://github.com/caliope-app/caliope/releases/latest), unzip it and run `Caliope.cmd`.
- Caliope tells you when an update is out and installs it with one click, or by itself if you turn that on in Settings. Uninstall in Windows Settings → Apps. Your sessions stay in `%LOCALAPPDATA%\Caliope` until you delete that folder.

How to use it: [the docs](https://caliope.be/docs.html).

## Develop

Plain JavaScript on Node.js, no dependencies.

```
node --use-system-ca server/main.js --open        # run from source
node --test --test-concurrency=1 "test/*.test.js"  # tests
node tools/package.mjs --no-npm                    # test build in dist\
```

- The tests run the real app against `tools/mock-copilot.js`, a fake Copilot API. A tag such as `[mock:edit notes.txt]` in a message picks a scenario.
- To release, commit the new version in `package.json` and push a tag `v<version>`. The release workflow tests, builds and installs the zip before it publishes.

## Good to know

- Each person needs their own Copilot seat. Check your company's and your clients' rules for AI tools.
- Caliope calls the Copilot service directly and identifies itself as GitHub's Copilot CLI. That service isn't a documented public API, so GitHub can change it.
- Forks need their own GitHub OAuth App, with Device Flow on: put its client ID in `server/config.js`.
- No telemetry. MIT license, no warranty: the agent runs commands with the permissions you give it.
- Not affiliated with GitHub, Microsoft, Anthropic, OpenAI or Google.
