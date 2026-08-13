# graph-prompt

**Stop prompt engineering. Start graph engineering.**

Instead of stuffing everything into one prompt, split the work into a graph of agent nodes — assign roles, wire the information flow (parallel / serial / loop), and press Enter. The graph executes like a prompt, with a full per-node trace.

[한국어 README](README.ko.md)

![demo](docs/demo.gif)

## Why

A single prompt is a black box. You can't see which claim came from which source, which step burned the time, or whether the counter-arguments were actually considered.

graph-prompt expresses the same task as a **graph**:

- **Node** = one agent (`claude` / `codex` / `research` / `red-team`)
- **Edge** = information flow. Parallel branches run **truly concurrently** (child processes spawned together)
- **Loop** = three exit conditions: count (`max=3`) / expression (`until(coverage>=0.9)`) / AI judgment (`until(is this verified enough)`)
- **Trace** = per node: the exact prompt sent, full output, source chain (`_sources`), tokens, cost, time

The graph is the source of truth; the MD file is its serialization. Round-trip is lossless — unparseable lines are rejected as errors, never silently dropped.

**vs. agent fleet managers (Orca, herdr):** those tools supervise *agents* — N independent attempts racing on the same task. graph-prompt designs the *information flow between agents* — branches doing different jobs, merging, looping with feedback. They compose well: run graph-prompt inside a herdr pane.

## What it looks like

Type a task in plain language → AI drafts a graph, streaming into the editor → drag/edit nodes on the canvas or in MD (bidirectional, real-time) → **Ctrl+Enter** → nodes light up as they run in parallel → the run lands in a stack → click one run for the full trace, click two for a **diff**.

The diff is the point: run the same question as a single prompt (1-node graph) and as a real graph, put them side by side, and see exactly where they diverged — per node, with receipts.

## Graph MD spec

One heading = one node.

```markdown
---
title: example
layout:
  a: [80, 40]        # canvas coordinates (optional)
---

## a `claude`
next: merge
prompt: |
  Return exactly the word "red".
out: {word: str}

## b `research`
next: merge
prompt: Find evidence on the web. Source URLs required.

## merge `claude`
in: a, b             # inferred from next: if omitted
loop: until(quality>=0.9, max=3) -> a
prompt: Synthesize both inputs.
```

- `next:` — downstream nodes (comma = parallel fan-out)
- `loop:` — on failure, re-run from the `->` target. **The failure reason is injected into the next iteration's prompt** — an improvement loop, not a re-roll of the same dice
- `lens:` — multiple lenses run concurrently (e.g. red-team through source-credibility / refutation / missing-angles)
- `out:` — output schema; node-to-node data is JSON
- If some parallel branches fail, the merge node proceeds with the surviving inputs (`degraded`); it is skipped only when all inputs are gone

## Run it

Requirements: Node 20.11+ (POSIX — Linux/macOS/WSL; on native Windows, cancel may leave child processes), a logged-in [Claude Code CLI](https://claude.com/claude-code). `codex` nodes need the [Codex CLI](https://github.com/openai/codex) (optional). **No extra API key** — it drives the CLIs you're already logged into.

> Note: graph runs consume your subscription quota (or API credits if your CLI is key-based). A multi-node research graph can be the equivalent of several dollars per run — the trace shows the exact per-node cost.

### Web console

```bash
cd web && npm install && npm run build && cd ..
npm start          # → http://localhost:4680 (127.0.0.1 only)
```

- Left: MD editor ↔ right: canvas, real-time bidirectional (drag = coordinates, connect = `next`)
- Bottom input: plain language → AI drafts/edits the graph (streaming)
- **⚡ Optimize**: redesigns the graph from your task + the latest run's per-node measurements
- **Roles** button: a curated library of graph-engineering roles (planner, fact-checker, devil's advocate, judge panel, …) — one click inserts a node template
- Run stack: 1 card = trace (prompt/output/sources/cost per node, critical path ⚡), 2 cards = diff
- Stop button kills the whole process group — no orphaned CLI processes

### CLI

```bash
node server/cli.mjs graphs/smoke.md
```

```
 0.002s ▶ run start — 3 nodes
 0.003s ┌ a [claude] start (iter 1)
 0.006s ┌ b [claude] start (iter 1)      ← true parallelism
  5.15s ┌ merge [claude] start (iter 1)
  9.22s ■ done · $0.0816 · failed [none]
```

Traces land in `runs/` in two forms:

- `*.jsonl` — incremental; if the run dies midway, everything up to that point survives
- `*.json` — complete, with the graph MD embedded at run time (enables run-to-run diff)

Nodes run isolated (`--strict-mcp-config --setting-sources ''`) — your personal settings and MCP servers never leak into node prompts, and the fixed context per call drops (measured median 48.5k → 8.9k tokens, n=3; the non-isolated number depends on your installed plugins. Reproduce: `node benchmarks/measure.mjs`).

## Security model

Local-only by design: the server binds to 127.0.0.1 and rejects cross-origin requests (Origin/Host validation — drive-by `fetch` from a malicious page gets 403). Web text collected by `research` nodes is taint-tracked and wrapped in per-block random delimiters before entering any downstream prompt, including loop feedback and loop judges — a hostile web page can't inject instructions into your `codex` nodes.

## Tests

```bash
npm test   # parser (22) + executor with mock CLIs (7), fully offline
```

## Roadmap

- [x] MD parser + lossless serialization
- [x] Parallel executor, 3 loop exit kinds, loop feedback injection
- [x] Per-node trace (prompt, output, source chain, cost), critical path
- [x] Web UI: canvas ↔ MD bidirectional, streaming AI draft, run stack + diff
- [x] Measured-run optimizer, role library, CSRF/injection hardening, CI
- [ ] `npx graph-prompt` one-command start
- [ ] Template gallery incl. a <$0.5 five-minute solo-vs-graph diff demo
- [ ] Race template (same graph ×N in parallel → judge) — self-consistency for decision graphs
- [ ] Trace HTML export for sharing

## License

MIT. Not affiliated with Anthropic or OpenAI; "Claude" and "Codex" refer to their respective CLIs.
