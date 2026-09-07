# Entropy

> **AI Agent Command Center — created by Kartheek (B.V.S. Kartheek)**
>
> One terminal, two agents: a **Job Agent** that hunts across 21 live public job boards and runs
> your application pipeline, and a **Coding Agent** that writes real applications and runs them
> live — dependencies auto-installed, start command read from the README, preview auto-booted.

🌐 **Live site (GitHub Pages):** <https://kartheekbvs.github.io/Entropy/>

![theme](https://img.shields.io/badge/theme-Verdant%20Farms%20Cinematic-71c84b?style=flat-square)
![stack](https://img.shields.io/badge/stack-Next.js%20%C2%B7%20Bun%20%C2%B7%20StackBlitz-22c55e?style=flat-square)
![agents](https://img.shields.io/badge/agents-Job%20%2B%20Coding-b7df62?style=flat-square&color=0b1f14)

---

## The two agents

The menu is a two-way toggle. Inside each agent, every section lives in a dropdown:

### 🧳 Job Agent — *hunt mode*
| Dropdown section | What it does |
|---|---|
| **Command Center** | mission stats, streak, ops strip |
| **Tracker** | application pipeline (saved → applied → interview → offer) |
| **Daily Feeds** | fresh listings swept from Naukri, LinkedIn, Internshala, Foundit + 17 more public boards |
| **Remote Python** | open-anywhere, fresher-friendly remote roles with verified board links |
| **JD Match** | resume vs job-description scoring + gap analysis |
| **Contacts** | recruiter book with follow-up radar |

### ⌨️ Coding Agent — *build mode*
| Dropdown section | What it does |
|---|---|
| **Agent Console** | goal in → plan → tools execute on the workspace → transcript + live xterm.js terminal |
| **Live App Preview** | the agent's app **runs inside the chat** on StackBlitz WebContainers — README-read auto-run, deps auto-install, live fs diffs, auto-reboot on new projects |
| **Preview Studio** | pages lens, device toolbar (desktop / 768 / 390), console drawer, ports strip |

## Quick start

```bash
bun install          # or npm install
bun run dev          # or npm run dev
```

Open <http://localhost:3000>. Configure providers in `.env` (see `.env.example`):

```
EXPLABS_API_KEY=…      # Experiential Labs gateway (primary, 300+ models)
OPENROUTER_API_KEY=…   # free chain fallback
NVIDIA_API_KEY=…       # NIM fallback
GROQ_API_KEY=…         # last-resort fallback
```

> **Note:** never commit `.env` — this repo ships `.env.example` only.
> API keys are read from environment variables everywhere (including the OpenRelay gateway:
> `openrelay/config.json` points at env var names).

## What's inside

```
src/
  app/                    Next.js app router (UI + 30+ API routes)
    api/agent/            the autonomous agent (run, chat, events, terminal, autopilot)
    api/preview/          live preview: workspace pages + StackBlitz project feed + SSE
    api/jobs/             remote Python job radar
  components/dashboard/   the Entropy UI (dual-agent command center, StackBlitz embed,
                          preview studio, xterm console, workspace explorer)
  lib/agent/              provider chain, runner, tools, coding tools, MCP client, scheduler
  lib/stackblitz-project  README-reading analyzer → embeddable project payload
openrelay/                circular LLM gateway (breaker, queue, usage, provider rotation)
mcp-server/               MCP server for Claude Code (`bun run mcp`)
docs/                     this GitHub Pages site (static, zero build)
workspace/                the agent's live workspace (it writes code here)
scripts/                  dev verification suite (test-v45 / v47 / v49 …)
```

## How the live preview works

1. The coding agent writes a project into `workspace/`.
2. `/api/preview/stackblitz` reads the tree + **README** (title, description, `npm run …`,
   `uvicorn …`) and builds a bounded, embeddable project payload.
3. The chat embeds it with the [StackBlitz SDK](https://stackblitz.com/docs): `clickToLoad: false`,
   dependencies auto-install, the README's start command runs, and the preview boots **hands-off**.
4. Delete the old project, generate a new site — the coordinator detects the structural change and
   **auto-boots the new app** on the agent's next pause (quiet-gated, 25 s max wait).

## Verify it works

```bash
bun scripts/test-v45.ts    # tracker + agent units
bun scripts/test-v47.ts    # live preview routes + SSE
bun scripts/test-v49.ts    # StackBlitz auto-run coordination
node openrelay/test/smoke.js   # OpenRelay gateway (29 checks)
```

## License

MIT — see [LICENSE](workspace/LICENSE).

---

Built by **B.V.S. Kartheek** · ML/AI · Python · [github.com/kartheekbvs](https://github.com/kartheekbvs)
