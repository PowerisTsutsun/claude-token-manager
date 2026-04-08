# Claude Token Manager

A VS Code extension that adds two missing features to the **Claude Code VS Code extension**:

1. **Token Usage Display** — a numeric status bar item showing exactly how much of Claude's context window is in use, with a detailed breakdown panel.
2. **Automatic .md Memory System** — watches your Claude sessions passively, auto-summarizes them using the Anthropic API, and builds a living memory file that you can paste at the start of any new session so Claude never re-learns the same things twice.

---

## Requirements

- VS Code 1.85.0 or later
- The [Claude Code VS Code extension](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) installed and in use
- Node.js 18+ (to build from source)
- An Anthropic API key (only required for the auto-summarization feature)

---

## Installation (from source)

```bash
# 1. Clone / download this folder
cd claude-token-manager

# 2. Install dev dependencies
npm install

# 3. Compile TypeScript
npm run compile

# 4. Package as a .vsix
npm run package

# 5. Install in VS Code
code --install-extension claude-token-manager-0.1.0.vsix
```

Or press **F5** inside VS Code with this folder open to launch an Extension Development Host for testing.

---

## Setup

### API Key (required for auto-summarization)

On first activation you will see a notification prompting you to add your Anthropic API key.  
Click **Add API Key** and paste your key (starts with `sk-ant-`).

The key is stored in VS Code's encrypted **SecretStorage** — never in `settings.json` or any plain-text file.

You can update it at any time via the Command Palette:

```
Claude Token Manager: Set API Key
```

---

## Feature 1 — Token Usage Display

### How it works

The extension watches `~/.claude/projects/{your-workspace}/` for `.jsonl` files that Claude Code writes during sessions. It parses those files passively (read-only, never writes) and aggregates token counts.

### Status bar

A persistent item in the right side of the status bar shows:

```
⚡ 42,310 / 200,000 tokens
```

| Color  | Meaning              |
|--------|----------------------|
| Green  | < 50 % context used  |
| Yellow | 50 – 80 % used       |
| Red    | > 80 % used          |

Updates within 2 seconds of any Claude Code activity. Shows `⚡ No active Claude session` when idle.

### Token usage panel

Click the status bar item (or run **Claude Token Manager: Show Token Usage Panel**) to open a webview showing:

- Tokens used vs. remaining (progress bar)
- Input / output / cache-read token breakdown
- Rough cost estimate at Claude Sonnet 4.5 pricing ($3/M input, $15/M output)
- Bar chart of token usage across the last 20 conversation turns
- **Clear Session View** button

> **Note:** The panel shows data from the most recently active `.jsonl` file. The `currentContextSize` shown in the status bar is the `input_tokens` value from the most recent assistant turn — this is the actual context window fill reported by the API, not a running total.

---

## Feature 2 — Automatic Memory System

### File structure

On first activation the extension creates a `claude-memory/` directory in your workspace root:

```
your-project/
└── claude-memory/
    ├── MEMORY.md      ← auto-updated, copy-paste this into new sessions
    ├── BUG_FIXES.md   ← append-only log of every bug resolved
    ├── DECISIONS.md   ← append-only log of architectural decisions
    └── SUMMARY.md     ← human-facing overview (not injected)
```

### Auto-summarization

After a Claude Code session goes **idle for 60 seconds** (no new writes to the `.jsonl` file), the extension:

1. Reads the session transcript from the `.jsonl` file
2. Sends it to `claude-haiku-4-5-20251001` (the cheapest model — summarization doesn't need Sonnet)
3. Extracts: project context, tech stack, conventions, key files, bug fixes, decisions, open issues
4. Appends new bug fixes to `BUG_FIXES.md` and decisions to `DECISIONS.md`
5. Rewrites `MEMORY.md` to stay under ~800 tokens

### Auto-injection into new sessions

When a **new session ID** appears in the `.jsonl` files (i.e. you started a fresh Claude conversation), the extension automatically:

1. Reads `MEMORY.md`
2. Copies it to your **clipboard**
3. Shows a notification:

   > *"Claude memory loaded (~320 tokens) — paste at the start of your prompt with Ctrl+V to give Claude full project context"*

This avoids any monkey-patching of VS Code internals. Just Ctrl+V at the start of your prompt.

### Commands

| Command | Description |
|---------|-------------|
| `Claude Token Manager: Show Token Usage Panel` | Open the token details webview |
| `Claude Token Manager: Set API Key` | Store your Anthropic API key securely |
| `Claude Token Manager: Summarize Session Now` | Trigger summarization immediately without waiting for idle |
| `Claude Token Manager: Open Memory File` | Open `MEMORY.md` in the editor |
| `Claude Token Manager: Open Bug Fixes` | Open `BUG_FIXES.md` in the editor |
| `Claude Token Manager: Search Bug Fixes` | Quick-pick search over all bug fixes by title, tag, or file |
| `Claude Token Manager: Clear Memory` | Wipe all `claude-memory/` files and start fresh (with confirmation) |

### Bug Fix Search

Run **Claude Token Manager: Search Bug Fixes** to open a searchable list of every bug fix ever recorded. Search by:

- Bug title / description
- Tags (e.g. `typescript`, `auth`, `ui`)
- File names

Selecting an entry opens a detail panel with the full bug report. Use this before asking Claude to solve a problem you may have already solved.

---

## Privacy & Security

- The extension only **reads** `.jsonl` files written by Claude Code. It never writes to them.
- Your API key is stored in VS Code `SecretStorage` (OS-level keychain on Windows/macOS, libsecret on Linux). It is never written to disk in plain text.
- The API key is used **only** for the summarization call to `claude-haiku-4-5-20251001`. No other data is sent to Anthropic beyond what you explicitly summarize.
- `claude-memory/` files are local to your workspace. Add `claude-memory/` to `.gitignore` if you don't want them committed.

---

## How Claude Code JSONL files are located

Claude Code stores session transcripts in:

```
~/.claude/projects/{encoded-workspace-path}/*.jsonl
```

The workspace path encoding replaces path separators with hyphens. For example:

| Platform | Workspace path | Encoded folder name |
|----------|---------------|---------------------|
| Linux / macOS | `/home/user/myproject` | `-home-user-myproject` |
| Windows | `C:\Users\user\myproject` | `C:-Users-user-myproject` |

The extension tries several encoding variants automatically to handle platform differences.

---

## Configuration

One optional setting is available in VS Code settings (`Ctrl+,`):

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeTokenManager.contextWindowSize` | `200000` | Context window size used for the percentage display |

---

## Limitations

- The token panel opens with a snapshot at click time and does not auto-refresh. Close and reopen to see updated data, or use the status bar for live numbers.
- If Claude Code creates a `.jsonl` file and adds the session ID before the extension detects it as "new", the clipboard injection may be missed for that session. Subsequent sessions will always be caught.
- Summarization requires an internet connection and a valid Anthropic API key. If summarization fails the session data is not lost — you can retry with **Summarize Session Now**.
- The cost estimate uses Sonnet 4.5 pricing regardless of the actual model Claude Code uses. Check `costUSD` fields in the `.jsonl` files for exact costs.

---

## Author

PowerisTsutusn
