<div align="center">

**English** · **[简体中文](./README.md)**

# deepseek-cli (dskts)

**Ask DeepSeek's web UI from your terminal**

`answers on stdout` · `hot reconnect ≈3s` · `no API billing` · `no CAPTCHAs`

</div>

> [!IMPORTANT]
> Answers go to <samp>stdout</samp>, progress logs to <samp>stderr</samp> — pipeable, callable from scripts and other agents.

There is exactly one implementation, in [`dskts/`](dskts/) (TypeScript + Playwright + a resident keeper process). The full command table, attribution-marker rules, architecture and security model live in [`dskts/README.md`](dskts/README.md). An earlier implementation — hand-written Marionette protocol in Python — was superseded and removed by this version; its design notes and field records remain in the `output/` and `docs/` archives and in git history.

## ⌨️ Quick start

```
dskts up                       # start; a login window pops up on first run (login state persists)
dskts "your question"          # continues this agent's thread; stdout carries answers only
dskts --stream "your question" # stream while generating (delta every 3 s)
dskts --out answer.md "..."    # also write the answer to a file (verbatim match with stdout)
dskts --file note.md "..."     # attach files (repeatable; whitelist = the page input's accept)
dskts --max-wait 420 "..."     # total wait cap (default 240 s, hard cap 3600)
dskts --chat keyword "..."     # pick a thread to continue (ambiguous → exit 2 with candidates)
dskts chats / rm keyword / status / down / whoami
```

Daily flow: <kbd>dskts up</kbd> → <kbd>dskts "anything"</kbd> → <kbd>dskts down</kbd>

Requires Node ≥ 24 (runs `.ts` directly via type stripping, no build step); install the browser once with `npx playwright install firefox`.

## ⚙️ How it works

<abbr title="Keep Alive resident process">keeper</abbr> exists to compress the cold-start cost from "every single question" down to "the first question of the day". The two-process structure allows exactly one automation connection on <mark>127.0.0.1:3928</mark> — while keeper is busy, later commands exit 2 immediately, no queueing.

```
dskts CLI
  │  127.0.0.1:3928 · serial · busy → exit 2 · parses and identifies the caller
  ▼
keeper (resident)   Firefox persistent ctx
  │  cold start ≤15s, once · then hot reconnect ≈3s · reads the page content
  ▼
DeepSeek web UI   your own logged-in session

stdout = the answer verbatim      stderr = progress logs
login state persists at %LOCALAPPDATA%\dsk-ffprofile      down wipes it
```

Reading the answer: text is taken from four points — the answer container, the thinking block, the code-block banner, and the Stop button; a round counts as finished only when the Stop button appears and then disappears. Reading and stabilization details are in the collapsed section.

<details>
<summary><b>Reading & stabilization details</b></summary>

`.ds-assistant-message-main-content` (answer), `.ds-think-content` (thinking), `.md-code-block-banner-wrap` (code banner), and the Stop button. Strategy: the button appears → the round starts; the button disappears → the round ends, read "everything".

**Attribution markers**: threads continue via automatic prefixes on the message container (`bf`, `dltk` — anti-scraping tokens, never forged). A marked question can continue a thread; ambiguous matches exit 2 with candidates — never guess.

</details>

## 📏 Three hard rules

> [!WARNING]
> **No exfiltration** — only tool usage, verbatim errors, and generic technical questions ever leave the machine; answer content and unpublished material never do.
>
> **No forgery** — never fake `bf`/`dltk`-style anti-scraping tokens, never replay session credentials outside the browser.
>
> **Deletion is gated** — only sessions with a known agent prefix may be deleted; anything else is refused. <kbd>--any</kbd> is an explicit override.

## 🧪 How to verify

```
node tests/bridge.test.ts    # advisor bridge: protocol parsing, gates, EXPECT checks
node tests/env.test.ts       # sweep gate and the sweep.ps1 encoding guard
node tools/mutate_bridge.mjs # mutation self-test: break the implementation piece by piece, expect red tests
node tools/probe_prime.ts    # online probe: selector rot, reading health
```

The three layers prove different things and cannot replace each other: offline tests prove the judging logic; the online probe proves "the page still looks like this today"; the only end-to-end criterion that counts is <mark>stdout matching, verbatim, what a human sees on the page</mark>.

## 🗂 Repo map

| Path | Contents |
|---|---|
| `dskts/` | the entire implementation (CLI, keeper, bridge, tests, `tools/` probes) |
| `dskts/README.md` | full command table, attribution-marker rules, architecture page, host constraints, security model |
| `output/` | migration planning and Gate risk-control acceptance records |
| `docs/` | external review transcripts and technical notes with field details (historical archive) |

<details>
<summary><b>Known limitations & TODO</b></summary>

### Known limitations

This automates your own logged-in web UI, which may not comply with the site's terms of service; the risk of account restriction or silent downgrade is yours to bear.

A page redesign breaks selectors at these points: `.ds-assistant-message-main-content` (answer), `.ds-think-content` (thinking), `.md-code-block-banner-wrap` (code banner), and the Stop button. When that happens, re-probe — `dskts/tools/probe_prime.ts` reports contamination directly.

Only one automation connection at a time: while keeper is busy, later commands exit 2 — no queue.

### TODO

- **Evaluate merging into `D:\G\github\游览器agent`** (browser-agent 3.0.0 already has an MCP Server, CLI and plugin mechanism) instead of growing a parallel set.
- **The extension route is shelved**: Edge extension + Native Messaging, taking the page's response stream instead of scraping the DOM. Of its three original problems, credentials-at-rest are solved by "persistent profile + explicit `down` wipe", cold-start slowness by "resident keeper + hot reconnect"; the remaining two (DOM scraping, re-probing after redesigns) don't justify a rewrite yet. Reopen when the response stream becomes unavailable or selectors rot frequently.

</details>

---

<div align="center">

**[🌍 Website](https://lll-404.github.io/)** · **[GitHub](https://github.com/LLL-404)** · **[📧 Email](mailto:2350178663@qq.com)**

</div>
