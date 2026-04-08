import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CONTEXT_WINDOW      = 200_000;
const SONNET_IN_PRICE_PM  = 3.0;    // $ per million input  tokens (Sonnet 4.5)
const SONNET_OUT_PRICE_PM = 15.0;   // $ per million output tokens (Sonnet 4.5)
const SESSION_IDLE_MS     = 60_000; // 60 s of no writes → session ended
const POLL_INTERVAL_MS    = 2_000;  // fallback poll interval
const MEMORY_DIR_NAME     = 'claude-memory';
const HAIKU_MODEL         = 'claude-haiku-4-5-20251001';
const SECRET_KEY_ID       = 'claude-token-manager.apiKey';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface JsonlEntry {
  type:       string;
  message?: {
    role?:    string;
    content?: unknown;
    usage?: {
      input_tokens?:                number;
      output_tokens?:               number;
      cache_read_input_tokens?:     number;
      cache_creation_input_tokens?: number;
    };
  };
  uuid?:      string;
  timestamp?: string;
  sessionId?: string;
  costUSD?:   number;
  cwd?:       string;
}

interface TurnStats {
  inputTokens:  number;
  outputTokens: number;
  timestamp:    string;
}

interface SessionStats {
  sessionId:          string;
  inputTokens:        number;
  outputTokens:       number;
  cacheReadTokens:    number;
  currentContextSize: number; // last turn's input_tokens = current context window usage
  estimatedCostUSD:   number;
  turns:              TurnStats[];
  startTime:          string;
  lastActivityTime:   string;
  rawEntries:         JsonlEntry[];
}

interface SummaryResult {
  project_context: string;
  tech_stack:      string[];
  conventions:     string[];
  key_files:       Array<{ path: string; role: string }>;
  bug_fixes:       Array<{
    bug:            string;
    cause:          string;
    fix:            string;
    files_affected: string[];
    tags:           string[];
  }>;
  decisions: Array<{
    decision:              string;
    reason:                string;
    alternatives_rejected: string[];
  }>;
  open_issues: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/**
 * Claude Code stores session data under ~/.claude/projects/{encoded-path}/.
 * The encoding replaces path separators (and on Windows, the colon after the
 * drive letter) with hyphens.  We try several encoding strategies to handle
 * subtle platform differences without breaking if one variant is wrong.
 */
function findProjectJsonlDir(workspacePath: string): string | null {
  const base = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(base)) { return null; }

  const fwd = workspacePath.replace(/\\/g, '/');
  const candidates = new Set([
    fwd.replace(/\//g, '-'),
    fwd.replace(/:/g, '').replace(/\//g, '-'),
    workspacePath.replace(/[/\\:]/g, '-'),
    workspacePath.replace(/[/\\]/g, '-'),
  ]);

  for (const enc of candidates) {
    const dir = path.join(base, enc);
    if (fs.existsSync(dir)) { return dir; }
  }
  return null;
}

function getJsonlFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

function parseJsonlFile(filePath: string): JsonlEntry[] {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .flatMap(l => { try { return [JSON.parse(l) as JsonlEntry]; } catch { return []; } });
  } catch { return []; }
}

function mostRecentJsonlFile(dir: string): { filePath: string; size: number; mtime: number } | null {
  const files = getJsonlFiles(dir);
  if (!files.length) { return null; }

  let best: { filePath: string; size: number; mtime: number } | null = null;
  for (const f of files) {
    try {
      const s = fs.statSync(f);
      if (!best || s.mtimeMs > best.mtime) {
        best = { filePath: f, size: s.size, mtime: s.mtimeMs };
      }
    } catch { /* skip */ }
  }
  return best;
}

function computeSessionStats(entries: JsonlEntry[]): SessionStats | null {
  // Group by session ID; use only the most recent session.
  const sessionIds = [...new Set(
    entries.map(e => e.sessionId).filter((id): id is string => !!id)
  )];
  if (!sessionIds.length) { return null; }
  const lastSessionId = sessionIds[sessionIds.length - 1];
  const sessionEntries = entries.filter(e => e.sessionId === lastSessionId);

  const assistants = sessionEntries.filter(e => e.type === 'assistant' && e.message?.usage);
  if (!assistants.length) { return null; }

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCost = 0;
  const turns: TurnStats[] = [];

  for (const e of assistants) {
    const u   = e.message!.usage!;
    const inp = u.input_tokens  ?? 0;
    const out = u.output_tokens ?? 0;
    totalInput     += inp;
    totalOutput    += out;
    totalCacheRead += u.cache_read_input_tokens ?? 0;
    totalCost      += e.costUSD ?? 0;
    turns.push({ inputTokens: inp, outputTokens: out, timestamp: e.timestamp ?? '' });
  }

  if (totalCost === 0) {
    totalCost = (totalInput  / 1_000_000) * SONNET_IN_PRICE_PM
              + (totalOutput / 1_000_000) * SONNET_OUT_PRICE_PM;
  }

  // The most recent assistant turn's input_tokens is the current context window fill.
  const currentContextSize =
    assistants[assistants.length - 1].message?.usage?.input_tokens ?? 0;

  const timestamps = sessionEntries.filter(e => e.timestamp).map(e => e.timestamp!);

  return {
    sessionId:          lastSessionId,
    inputTokens:        totalInput,
    outputTokens:       totalOutput,
    cacheReadTokens:    totalCacheRead,
    currentContextSize,
    estimatedCostUSD:   totalCost,
    turns,
    startTime:          timestamps[0]                    ?? '',
    lastActivityTime:   timestamps[timestamps.length - 1] ?? '',
    rawEntries:         entries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic API helper
// ─────────────────────────────────────────────────────────────────────────────

function callAnthropicApi(
  apiKey: string,
  model:  string,
  system: string,
  user:   string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':          apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length':     Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(raw) as {
            error?: { message: string };
            content?: Array<{ type: string; text: string }>;
          };
          if (json.error) { reject(new Error(json.error.message)); return; }
          resolve(json.content?.[0]?.text ?? '');
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory System
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARIZER_SYSTEM_PROMPT = `You are a project memory assistant. Given a Claude Code session transcript, extract and return a JSON object with these fields:

{
  "project_context": "2-3 sentence summary of what the project does and its current state, written so Claude can immediately understand the codebase without reading files",
  "tech_stack": ["array", "of", "technologies", "confirmed", "in", "use"],
  "conventions": ["Specific coding patterns or rules observed in this session"],
  "key_files": [
    { "path": "relative/path/to/file.ts", "role": "what this file does" }
  ],
  "bug_fixes": [
    {
      "bug": "Short description of the bug",
      "cause": "What caused it",
      "fix": "Exactly how it was fixed",
      "files_affected": ["file1.ts", "file2.ts"],
      "tags": ["typescript", "auth", "ui"]
    }
  ],
  "decisions": [
    {
      "decision": "What was decided",
      "reason": "Why it was decided",
      "alternatives_rejected": ["other options that were ruled out"]
    }
  ],
  "open_issues": ["Anything unresolved or left as a TODO at the end of this session"]
}

Return ONLY valid JSON. No markdown, no preamble, no explanation.`;

class MemorySystem {
  private readonly memDir:        string;
  private readonly memoryFile:    string;
  private readonly bugFixFile:    string;
  private readonly decisionsFile: string;
  private readonly summaryFile:   string;

  constructor(_ctx: vscode.ExtensionContext, workspaceRoot: string) {
    this.memDir        = path.join(workspaceRoot, MEMORY_DIR_NAME);
    this.memoryFile    = path.join(this.memDir, 'MEMORY.md');
    this.bugFixFile    = path.join(this.memDir, 'BUG_FIXES.md');
    this.decisionsFile = path.join(this.memDir, 'DECISIONS.md');
    this.summaryFile   = path.join(this.memDir, 'SUMMARY.md');
  }

  get exists(): boolean { return fs.existsSync(this.memDir); }
  get memoryFilePath(): string { return this.memoryFile; }
  get bugFixFilePath():  string { return this.bugFixFile; }

  initialize(): void {
    if (!fs.existsSync(this.memDir)) {
      fs.mkdirSync(this.memDir, { recursive: true });
    }

    const defaults: Array<[string, string]> = [
      [this.memoryFile,    '# Project Memory\n\n*No sessions summarized yet.*\n'],
      [this.bugFixFile,    '# Bug Fix Log\n\n'],
      [this.decisionsFile, '# Decisions Log\n\n'],
      [this.summaryFile,   '# Project Summary\n\nThis file is a human-facing overview. It is not auto-injected into sessions.\n'],
    ];

    for (const [fp, content] of defaults) {
      if (!fs.existsSync(fp)) { fs.writeFileSync(fp, content, 'utf-8'); }
    }
  }

  async summarizeSession(entries: JsonlEntry[], apiKey: string): Promise<void> {
    const transcript = this.buildTranscript(entries);
    if (!transcript.trim()) { return; }

    let raw: string;
    try {
      raw = await callAnthropicApi(apiKey, HAIKU_MODEL, SUMMARIZER_SYSTEM_PROMPT, transcript);
    } catch (e) {
      vscode.window.showErrorMessage(
        `Claude Token Manager: Summarization failed — ${(e as Error).message}`
      );
      return;
    }

    let summary: SummaryResult;
    try {
      // Strip markdown code fences if the model wrapped the JSON
      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      summary = JSON.parse(cleaned) as SummaryResult;
    } catch {
      vscode.window.showErrorMessage(
        'Claude Token Manager: Could not parse summarization response.'
      );
      return;
    }

    this.mergeSummary(summary);
    vscode.window.showInformationMessage(
      'Claude Token Manager: Session summarized and memory updated.'
    );
  }

  private buildTranscript(entries: JsonlEntry[]): string {
    const lines: string[] = [];

    for (const e of entries) {
      if (e.type === 'user' && e.message?.content) {
        const c = typeof e.message.content === 'string'
          ? e.message.content
          : JSON.stringify(e.message.content);
        lines.push(`USER: ${c}`);
      } else if (e.type === 'assistant' && e.message?.content) {
        const raw = e.message.content;
        const c = Array.isArray(raw)
          ? (raw as Array<{ type: string; text?: string }>)
              .filter(x => x.type === 'text')
              .map(x => x.text ?? '')
              .join('\n')
          : String(raw);
        if (c.trim()) { lines.push(`ASSISTANT: ${c}`); }
      }
    }

    return lines.join('\n\n');
  }

  private mergeSummary(s: SummaryResult): void {
    const ts = new Date().toISOString();

    // Append bug fixes
    if (s.bug_fixes?.length) {
      let content = '';
      for (const bf of s.bug_fixes) {
        content += `\n[${ts}] ${bf.bug}\n`;
        content += `Bug: ${bf.bug}\nCause: ${bf.cause}\nFix: ${bf.fix}\n`;
        content += `Files: ${bf.files_affected.join(', ')}\nTags: ${bf.tags.join(', ')}\n---\n`;
      }
      fs.appendFileSync(this.bugFixFile, content, 'utf-8');
    }

    // Append decisions
    if (s.decisions?.length) {
      let content = '';
      for (const d of s.decisions) {
        content += `\n[${ts}] ${d.decision}\n`;
        content += `Decision: ${d.decision}\nReason: ${d.reason}\n`;
        if (d.alternatives_rejected?.length) {
          content += `Alternatives rejected: ${d.alternatives_rejected.join(', ')}\n`;
        }
        content += `---\n`;
      }
      fs.appendFileSync(this.decisionsFile, content, 'utf-8');
    }

    this.rebuildMemoryMd(s, ts);
  }

  private rebuildMemoryMd(s: SummaryResult, ts: string): void {
    const recentBugs      = this.recentEntries(this.bugFixFile, 5);
    const recentDecisions = this.recentEntries(this.decisionsFile, 5);

    const bullets = (arr: string[] | undefined) =>
      arr?.length ? arr.map(x => `- ${x}`).join('\n') : '- (none recorded)';

    const keyFilesLines = s.key_files?.length
      ? s.key_files.map(f => `- ${f.path} — ${f.role}`).join('\n')
      : '- (none recorded)';

    const content = [
      '# Project Memory',
      `Last updated: ${ts}`,
      '',
      '## What This Project Does',
      s.project_context ?? 'Not yet summarized.',
      '',
      '## Tech Stack',
      bullets(s.tech_stack),
      '',
      '## Conventions',
      bullets(s.conventions),
      '',
      '## Key Files',
      keyFilesLines,
      '',
      '## Known Bug Fixes',
      bullets(recentBugs),
      '',
      'See BUG_FIXES.md for full history.',
      '',
      '## Decisions Made',
      bullets(recentDecisions),
      '',
      'See DECISIONS.md for full history.',
      '',
      '## Open Issues',
      bullets(s.open_issues),
    ].join('\n');

    fs.writeFileSync(this.memoryFile, content, 'utf-8');
  }

  /** Read the last `count` log entries from a `---`-separated file. */
  private recentEntries(filePath: string, count: number): string[] {
    try {
      return fs.readFileSync(filePath, 'utf-8')
        .split('---')
        .filter(e => e.trim() && !e.trim().startsWith('#'))
        .slice(-count)
        .map(e => {
          const m = e.trim().match(/\] (.+)/);
          return m ? m[1].trim() : e.trim().split('\n')[0] ?? '';
        })
        .filter(Boolean);
    } catch { return []; }
  }

  readMemory(): string {
    try { return fs.readFileSync(this.memoryFile, 'utf-8'); } catch { return ''; }
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4); // ~4 chars per token
  }

  async loadToClipboard(): Promise<void> {
    const memory = this.readMemory();
    if (!memory || memory.includes('No sessions summarized yet')) { return; }

    const tokens = this.estimateTokens(memory);
    await vscode.env.clipboard.writeText(memory);
    vscode.window.showInformationMessage(
      `Claude memory loaded (~${tokens} tokens) — paste at the start of your prompt with Ctrl+V to give Claude full project context`
    );
  }

  parseBugFixes(): Array<{
    label: string; description: string; detail: string; full: string;
  }> {
    try {
      return fs.readFileSync(this.bugFixFile, 'utf-8')
        .split('---')
        .filter(e => e.trim() && !e.trim().startsWith('#'))
        .map(entry => {
          const lines      = entry.trim().split('\n');
          const headerMatch = lines[0]?.match(/\] (.+)$/);
          const label       = headerMatch ? headerMatch[1].trim() : (lines[0] ?? '(unknown)');
          const tagsLine    = lines.find(l => l.startsWith('Tags:'))  ?? '';
          const filesLine   = lines.find(l => l.startsWith('Files:')) ?? '';
          return {
            label,
            description: tagsLine.replace('Tags:',  '').trim(),
            detail:      filesLine.replace('Files:', '').trim(),
            full:        entry.trim(),
          };
        });
    } catch { return []; }
  }

  clearAll(): void {
    if (fs.existsSync(this.memDir)) {
      fs.rmSync(this.memDir, { recursive: true, force: true });
    }
    this.initialize();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Tracker
// ─────────────────────────────────────────────────────────────────────────────

class TokenTracker {
  private session:       SessionStats | null = null;
  private statusBar:     vscode.StatusBarItem;
  private dirWatcher:    fs.FSWatcher | null = null;
  private pollTimer:     NodeJS.Timeout | null = null;
  private idleTimer:     NodeJS.Timeout | null = null;
  private initialized  = false;
  private knownSessions = new Set<string>();
  private lastStat:      { path: string; size: number; mtime: number } | null = null;
  private projectDir:    string | null = null;

  onSessionEnd: ((entries: JsonlEntry[]) => void) | null = null;
  onNewSession: (() => void)                            | null = null;

  constructor(statusBar: vscode.StatusBarItem) {
    this.statusBar = statusBar;
  }

  start(workspacePath: string): void {
    this.projectDir = findProjectJsonlDir(workspacePath);

    if (!this.projectDir) {
      // Claude hasn't run in this workspace yet — poll for the directory to appear.
      const dirPoller = setInterval(() => {
        this.projectDir = findProjectJsonlDir(workspacePath);
        if (this.projectDir) {
          clearInterval(dirPoller);
          this.startWatching();
        }
      }, 5_000);
    } else {
      this.startWatching();
    }

    this.updateStatusBar();
  }

  private startWatching(): void {
    if (!this.projectDir) { return; }

    // Initial load — populate known sessions without firing callbacks.
    this.refresh(true);

    // Watch directory for new/changed JSONL files.
    try {
      this.dirWatcher = fs.watch(
        this.projectDir,
        { persistent: false },
        () => this.refresh(false),
      );
    } catch { /* fs.watch unavailable on this system; fall back to polling only */ }

    // Polling backup (also ensures we catch changes within 2 s).
    this.pollTimer = setInterval(() => this.refresh(false), POLL_INTERVAL_MS);
  }

  private refresh(initialLoad: boolean): void {
    if (!this.projectDir) { return; }

    const most = mostRecentJsonlFile(this.projectDir);
    if (!most) {
      this.session = null;
      this.updateStatusBar();
      return;
    }

    const { filePath, size, mtime } = most;
    const changed = !this.lastStat
      || this.lastStat.path  !== filePath
      || this.lastStat.size  !== size
      || this.lastStat.mtime !== mtime;

    this.lastStat = { path: filePath, size, mtime };

    // Skip re-parse if nothing changed and we've already initialized.
    if (!changed && this.initialized) { return; }

    const entries = parseJsonlFile(filePath);
    this.session  = computeSessionStats(entries);
    this.updateStatusBar();

    const ids = new Set(
      entries.map(e => e.sessionId).filter((id): id is string => !!id)
    );

    if (initialLoad || !this.initialized) {
      // First run: record existing sessions so future new ones can be detected.
      ids.forEach(id => this.knownSessions.add(id));
      this.initialized = true;
    } else if (changed) {
      let hasNew = false;
      for (const id of ids) {
        if (!this.knownSessions.has(id)) {
          this.knownSessions.add(id);
          hasNew = true;
        }
      }
      if (hasNew && this.onNewSession) { this.onNewSession(); }

      // Reset 60-second idle countdown on every file change.
      this.resetIdleTimer(entries);
    }
  }

  private resetIdleTimer(entries: JsonlEntry[]): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); }
    this.idleTimer = setTimeout(() => {
      if (this.onSessionEnd && entries.length) { this.onSessionEnd(entries); }
    }, SESSION_IDLE_MS);
  }

  private updateStatusBar(): void {
    if (!this.session) {
      this.statusBar.text    = '⚡ No active Claude session';
      this.statusBar.color   = undefined;
      this.statusBar.tooltip = 'Claude Token Manager — click for details';
      return;
    }

    const used = this.session.currentContextSize;
    const pct  = used / CONTEXT_WINDOW;

    this.statusBar.text = `⚡ ${fmt(used)} / ${fmt(CONTEXT_WINDOW)} tokens`;
    this.statusBar.tooltip = [
      `Session: ${this.session.sessionId.slice(0, 8)}…`,
      `Input tokens:  ${fmt(this.session.inputTokens)}`,
      `Output tokens: ${fmt(this.session.outputTokens)}`,
      `Cache read:    ${fmt(this.session.cacheReadTokens)}`,
      `Est. cost:     $${this.session.estimatedCostUSD.toFixed(4)}`,
      `Turns:         ${this.session.turns.length}`,
      '',
      'Click to open token panel',
    ].join('\n');

    // Green < 50 %, yellow 50–80 %, red > 80 %
    this.statusBar.color = pct < 0.5 ? '#4ec9b0' : pct < 0.8 ? '#cca700' : '#f48771';
  }

  getSession(): SessionStats | null { return this.session; }

  clearSession(): void {
    this.session = null;
    this.updateStatusBar();
  }

  dispose(): void {
    this.dirWatcher?.close();
    if (this.pollTimer) { clearInterval(this.pollTimer); }
    if (this.idleTimer) { clearTimeout(this.idleTimer); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Webview HTML — Token Panel
// ─────────────────────────────────────────────────────────────────────────────

function getTokenPanelHtml(session: SessionStats | null, nonce: string): string {
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;

  if (!session) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Claude Token Usage</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 24px; }
  p    { color: var(--vscode-descriptionForeground); line-height: 1.5; }
</style>
</head>
<body>
<h2>Claude Token Usage</h2>
<p>No active Claude Code session detected.<br>
Start a session and token data will appear here automatically within 2 seconds.</p>
</body>
</html>`;
  }

  const used       = session.currentContextSize;
  const total      = CONTEXT_WINDOW;
  const pct        = Math.min(100, Math.round((used / total) * 100));
  const remain     = Math.max(0, total - used);
  const barColor   = pct < 50 ? '#4ec9b0' : pct < 80 ? '#cca700' : '#f48771';
  const turns      = session.turns.slice(-20);
  const maxTk      = Math.max(...turns.flatMap(t => [t.inputTokens, t.outputTokens]), 1);
  const MAX_BAR_W  = 160;

  const turnsHtml = turns.map((t, i) => `
    <tr>
      <td class="lbl">Turn ${i + 1}</td>
      <td>
        <div class="bar-row">
          <div class="bar in-bar" style="width:${Math.round(t.inputTokens  / maxTk * MAX_BAR_W)}px"></div>
          <span class="bar-num">${fmt(t.inputTokens)}</span>
        </div>
        <div class="bar-row">
          <div class="bar out-bar" style="width:${Math.round(t.outputTokens / maxTk * MAX_BAR_W)}px"></div>
          <span class="bar-num">${fmt(t.outputTokens)}</span>
        </div>
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Claude Token Usage</title>
<style nonce="${nonce}">
  *  { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         padding: 20px; }
  h2   { font-size: 1.2em; margin-bottom: 16px; }
  h3   { font-size: .95em; margin-bottom: 10px; color: var(--vscode-descriptionForeground); }
  .card { background: var(--vscode-sideBar-background);
          border: 1px solid var(--vscode-widget-border, #3c3c3c);
          border-radius: 6px; padding: 14px; margin-bottom: 14px; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; }
  .row + .row { border-top: 1px solid var(--vscode-widget-border, #2d2d2d); }
  .lbl-txt { color: var(--vscode-descriptionForeground); font-size: .88em; }
  .val-txt  { font-weight: 600; font-variant-numeric: tabular-nums; }
  .cost     { color: #cca700; }
  .prog-wrap { background: var(--vscode-scrollbarSlider-background, #555);
               border-radius: 4px; height: 10px; margin: 10px 0 4px; overflow: hidden; }
  .prog-fill { height: 100%; border-radius: 4px; background: ${barColor}; width: ${pct}%; }
  .pct-hint  { font-size: .8em; color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; font-size: .82em; }
  .lbl  { color: var(--vscode-descriptionForeground); padding: 3px 10px 3px 0;
          white-space: nowrap; vertical-align: middle; }
  .bar-row { display: flex; align-items: center; gap: 6px; padding: 1px 0; }
  .bar     { height: 10px; border-radius: 2px; min-width: 2px; }
  .in-bar  { background: #4ec9b0; }
  .out-bar { background: #ce9178; }
  .bar-num { color: var(--vscode-descriptionForeground); font-size: .78em; }
  .legend  { display: flex; gap: 14px; margin-bottom: 8px; font-size: .8em;
             color: var(--vscode-descriptionForeground); }
  .dot     { width: 9px; height: 9px; border-radius: 2px;
             display: inline-block; margin-right: 3px; vertical-align: middle; }
  button   { margin-top: 4px; background: var(--vscode-button-background);
             color: var(--vscode-button-foreground); border: none; padding: 6px 14px;
             border-radius: 4px; cursor: pointer; font-size: .88em; font-family: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<h2>Claude Token Usage</h2>

<div class="card">
  <div class="row">
    <span class="lbl-txt">Context used</span>
    <span class="val-txt">${fmt(used)}</span>
  </div>
  <div class="row">
    <span class="lbl-txt">Context remaining</span>
    <span class="val-txt">${fmt(remain)}</span>
  </div>
  <div class="prog-wrap"><div class="prog-fill"></div></div>
  <div class="pct-hint">${pct}% of ${fmt(total)}-token limit</div>
</div>

<div class="card">
  <div class="row">
    <span class="lbl-txt">Total input tokens (session)</span>
    <span class="val-txt">${fmt(session.inputTokens)}</span>
  </div>
  <div class="row">
    <span class="lbl-txt">Total output tokens (session)</span>
    <span class="val-txt">${fmt(session.outputTokens)}</span>
  </div>
  <div class="row">
    <span class="lbl-txt">Cache read tokens</span>
    <span class="val-txt">${fmt(session.cacheReadTokens)}</span>
  </div>
  <div class="row">
    <span class="lbl-txt">Est. cost (Sonnet 4.5 pricing)</span>
    <span class="val-txt cost">$${session.estimatedCostUSD.toFixed(4)}</span>
  </div>
  <div class="row">
    <span class="lbl-txt">Conversation turns</span>
    <span class="val-txt">${session.turns.length}</span>
  </div>
</div>

<div class="card">
  <h3>Tokens per Turn${turns.length < session.turns.length ? ' (last 20)' : ''}</h3>
  <div class="legend">
    <span><span class="dot" style="background:#4ec9b0"></span>Input</span>
    <span><span class="dot" style="background:#ce9178"></span>Output</span>
  </div>
  <table>
    ${turnsHtml || '<tr><td colspan="2" style="color:var(--vscode-descriptionForeground)">No turns recorded yet.</td></tr>'}
  </table>
</div>

<button id="clearBtn">Clear Session View</button>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('clearBtn').onclick = () => vscode.postMessage({ type: 'clearSession' });
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webview HTML — Bug Fix Detail
// ─────────────────────────────────────────────────────────────────────────────

function getBugFixDetailHtml(content: string, nonce: string): string {
  const csp = `default-src 'none'; style-src 'nonce-${nonce}';`;
  const esc = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Bug Fix</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 24px; }
  h2   { margin-bottom: 16px; font-size: 1.1em; }
  pre  { white-space: pre-wrap; word-break: break-word;
         background: var(--vscode-textBlockQuote-background, #1e1e1e);
         border-left: 3px solid var(--vscode-textBlockQuote-border, #555);
         padding: 14px; border-radius: 0 4px 4px 0;
         font-family: var(--vscode-editor-font-family);
         font-size: var(--vscode-editor-font-size); }
</style>
</head>
<body>
<h2>Bug Fix Details</h2>
<pre>${esc}</pre>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension module-level state
// ─────────────────────────────────────────────────────────────────────────────

let tracker:    TokenTracker       | null = null;
let memorySys:  MemorySystem       | null = null;
let tokenPanel: vscode.WebviewPanel | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// activate
// ─────────────────────────────────────────────────────────────────────────────

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // ── Status bar item ────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 1000
  );
  statusBar.command = 'claude-token-manager.showTokenPanel';
  statusBar.text    = '⚡ No active Claude session';
  statusBar.tooltip = 'Claude Token Manager — click for details';
  statusBar.show();
  ctx.subscriptions.push(statusBar);

  // ── Memory system ──────────────────────────────────────────────────────────
  if (workspaceRoot) {
    memorySys = new MemorySystem(ctx, workspaceRoot);
    memorySys.initialize();
  }

  // ── Token tracker ──────────────────────────────────────────────────────────
  if (workspaceRoot) {
    tracker = new TokenTracker(statusBar);

    // When a new session starts → copy memory to clipboard
    tracker.onNewSession = async () => {
      if (memorySys) { await memorySys.loadToClipboard(); }
    };

    // When a session goes idle for 60 s → auto-summarize
    tracker.onSessionEnd = async (entries) => {
      const key = await ctx.secrets.get(SECRET_KEY_ID);
      if (!key || !memorySys) { return; }
      await memorySys.summarizeSession(entries, key);
    };

    tracker.start(workspaceRoot);
    ctx.subscriptions.push({ dispose: () => tracker?.dispose() });
  }

  // ── First-run API key prompt ───────────────────────────────────────────────
  const hasKey = !!(await ctx.secrets.get(SECRET_KEY_ID));
  if (!hasKey) {
    vscode.window.showInformationMessage(
      'Claude Token Manager needs your Anthropic API key for auto-summarization.',
      'Add API Key'
    ).then(sel => {
      if (sel) { vscode.commands.executeCommand('claude-token-manager.setApiKey'); }
    });
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  // Show / reveal the token usage webview panel
  ctx.subscriptions.push(vscode.commands.registerCommand(
    'claude-token-manager.showTokenPanel', () => {
      if (tokenPanel) { tokenPanel.reveal(); return; }

      tokenPanel = vscode.window.createWebviewPanel(
        'claudeTokenUsage',
        'Claude Token Usage',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );

      tokenPanel.webview.html = getTokenPanelHtml(
        tracker?.getSession() ?? null, generateNonce()
      );

      tokenPanel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'clearSession') {
          tracker?.clearSession();
          tokenPanel!.webview.html = getTokenPanelHtml(null, generateNonce());
        }
      }, undefined, ctx.subscriptions);

      tokenPanel.onDidDispose(() => { tokenPanel = null; }, undefined, ctx.subscriptions);
    }
  ));

  // Store API key in SecretStorage
  ctx.subscriptions.push(vscode.commands.registerCommand(
    'claude-token-manager.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt:        'Enter your Anthropic API key',
        password:      true,
        placeHolder:   'sk-ant-api03-…',
        validateInput: v =>
          v.startsWith('sk-ant-') ? null : 'Key must begin with sk-ant-',
      });
      if (key) {
        await ctx.secrets.store(SECRET_KEY_ID, key);
        vscode.window.showInformationMessage(
          'Claude Token Manager: API key saved to SecretStorage.'
        );
      }
    }
  ));

  // Summarize the current session immediately (without waiting for idle)
  ctx.subscriptions.push(vscode.commands.registerCommand(
    'claude-token-manager.summarizeNow', async () => {
      const key = await ctx.secrets.get(SECRET_KEY_ID);
      if (!key) {
        vscode.window.showErrorMessage(
          'Claude Token Manager: No API key set. Run "Claude Token Manager: Set API Key" first.'
        );
        return;
      }
      const session = tracker?.getSession();
      if (!session?.rawEntries.length || !memorySys) {
        vscode.window.showWarningMessage(
          'Claude Token Manager: No session data available to summarize.'
        );
        return;
      }
      await vscode.window.withProgress(
        {
          location:    vscode.ProgressLocation.Notification,
          title:       'Claude Token Manager: Summarizing session…',
          cancellable: false,
        },
        () => memorySys!.summarizeSession(session.rawEntries, key)
      );
    }
  ));

  // Open MEMORY.md
  ctx.subscriptions.push(vscode.commands.registerCommand(
    'claude-token-manager.openMemory', async () => {
      if (!memorySys) { return; }
      const doc = await vscode.workspace.openTextDocument(memorySys.memoryFilePath);
      vscode.window.showTextDocument(doc);
    }
  ));

  // Open BUG_FIXES.md
  ctx.subscriptions.push(vscode.commands.registerCommand(
    'claude-token-manager.openBugFixes', async () => {
      if (!memorySys) { return; }
      const doc = await vscode.workspace.openTextDocument(memorySys.bugFixFilePath);
      vscode.window.showTextDocument(doc);
    }
  ));

  // Quick-pick search over BUG_FIXES.md
  ctx.subscriptions.push(vscode.commands.registerCommand(
    'claude-token-manager.searchBugFixes', async () => {
      if (!memorySys) { return; }

      const items = memorySys.parseBugFixes();
      if (!items.length) {
        vscode.window.showInformationMessage(
          'Claude Token Manager: No bug fixes recorded yet.'
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        items.map(i => ({ ...i, alwaysShow: true })),
        {
          placeHolder:        'Search bug fixes by title, tag, or file…',
          matchOnDescription: true,
          matchOnDetail:      true,
        },
      );

      if (picked) {
        const panel = vscode.window.createWebviewPanel(
          'bugFixDetail',
          `Bug: ${picked.label}`,
          vscode.ViewColumn.Beside,
          { enableScripts: false },
        );
        panel.webview.html = getBugFixDetailHtml(picked.full, generateNonce());
      }
    }
  ));

  // Clear all memory files and start fresh
  ctx.subscriptions.push(vscode.commands.registerCommand(
    'claude-token-manager.clearMemory', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all Claude Token Manager memory files? This cannot be undone.',
        { modal: true },
        'Clear Memory',
      );
      if (confirm === 'Clear Memory' && memorySys) {
        memorySys.clearAll();
        vscode.window.showInformationMessage(
          'Claude Token Manager: Memory cleared and reset.'
        );
      }
    }
  ));
}

// ─────────────────────────────────────────────────────────────────────────────
// deactivate
// ─────────────────────────────────────────────────────────────────────────────

export function deactivate(): void {
  tracker?.dispose();
  tokenPanel?.dispose();
}
