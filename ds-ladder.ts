// ds-ladder — two-rung model ladder for the worker lanes (OpenCode v2.0.26).
// SPDX-License-Identifier: Unlicense
//
// Rung 1: the pinned model itself (the `opencode` provider free SKU). Unchanged.
// Rung 2: a paid OpenAI-compatible DeepSeek endpoint, resolved FRESH on every
//         trigger from ~/.config/ai/load-secrets.sh (PAID_DS_BASE_URL /
//         PAID_DS_API_KEY / PAID_DS_MODEL). Never cached.
//
// Scope: the `http.response` hook is registered provider-scoped to `opencode`,
// and engage logic only runs for kind === "primary" with a model id ending in
// "-free". Primary (opencode-go/*) and guineapig (litellm-ai/*) never see it.
//
// Rollback: rm this file (+ service restart to unload). No config edits.
//
// Contract notes:
//  - Promise hooks are void; mutation is in-place on the SAME event object:
//    `event.response = new Response(...)`.
//  - The whole callback is wrapped in try/catch: an uncaught rejection becomes
//    an Effect defect that kills the model request.
//  - No secret material is ever logged. The log carries only the rung-2
//    hostname, never the full URL or the API key.
//  - Rung-2 transport is openai-chat SSE only. A non-SSE 200 fails closed:
//    the original rung-1 response is passed through untouched.
//
// Diagnostics: JSONL at ~/.local/share/opencode/ds-ladder.log
// Sentinel (validation only): /srv/ssd/tmp/opencode/ds-ladder-selftest —
// when present on a primary/free event, one engagement is forced and the
// sentinel file is deleted on consumption.

import { execFile } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------- constants

const HOME = homedir()
const LOG_FILE = path.join(HOME, ".local/share/opencode/ds-ladder.log")
const SENTINEL_FILE = "/srv/ssd/tmp/opencode/ds-ladder-selftest"
const SECRETS_SCRIPT =
  'source ~/.config/ai/load-secrets.sh >/dev/null 2>&1; printf "%s\\x1f%s\\x1f%s" "$PAID_DS_BASE_URL" "$PAID_DS_API_KEY" "$PAID_DS_MODEL"'

const R1_MESSAGE_RE = /free usage|free tier|quota|exceeded|limit/i

const BURST_GATE_MS = 60_000
const BURST_EVICT_MS = 600_000
const HEADER_TIMEOUT_MS = 120_000

const USER_AGENT = "ds-ladder/1.0 (opencode plugin)"

// sessionID -> { burstStart: number }. Touched only by primary/free events.
const bursts = new Map<string, { burstStart: number }>()

// ---------------------------------------------------------------- diagnostics

function fileLog(entry: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n")
  } catch {
    // Diagnostics must never break the request.
  }
}

function errorClass(error: unknown): string {
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name
    if (typeof name === "string" && name.length > 0) {
      if (name === "AbortError") return "header-timeout"
      return name
    }
  }
  return "error"
}

// ---------------------------------------------------------------- model ref

interface ModelParts {
  readonly id: string
  readonly providerID: string
}

// Accepts the v2.0.26 Model.Ref struct (id/providerID/variant) and, defensively,
// a "provider/id#variant" string. The variant suffix is stripped per spec.
function modelParts(model: unknown): ModelParts {
  if (typeof model === "string") {
    const slash = model.indexOf("/")
    const providerID = slash > 0 ? model.slice(0, slash) : ""
    let id = slash > 0 ? model.slice(slash + 1) : model
    const hash = id.indexOf("#")
    if (hash >= 0) id = id.slice(0, hash)
    return { id, providerID }
  }
  if (model && typeof model === "object") {
    const raw = model as { id?: unknown; providerID?: unknown }
    const id = typeof raw.id === "string" ? raw.id.split("#")[0] : ""
    const providerID = typeof raw.providerID === "string" ? raw.providerID : ""
    return { id, providerID }
  }
  return { id: "", providerID: "" }
}

// ---------------------------------------------------------------- rung 2

interface Rung2 {
  readonly baseURL: string
  readonly apiKey: string
  readonly model: string
  readonly host: string
}

// Always resolved fresh (never cached between attempts).
async function resolveRung2(): Promise<Rung2 | null> {
  const { stdout } = await execFileAsync("bash", ["-lc", SECRETS_SCRIPT], {
    timeout: 15_000,
    maxBuffer: 65_536,
  })
  const parts = String(stdout).split("\x1f")
  if (parts.length !== 3) return null
  const [baseURL, apiKey, model] = parts.map((part) => part.trim())
  if (!baseURL || !apiKey || !model) return null
  if (!/^https?:\/\//.test(baseURL)) return null
  let host = ""
  try {
    host = new URL(baseURL).hostname
  } catch {
    return null
  }
  return { baseURL, apiKey, model, host }
}

// ---------------------------------------------------------------- response body

async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.clone().text()
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function bodyErrorFields(body: Record<string, unknown> | null): {
  errorType?: string
  message?: string
} {
  if (!body) return {}
  const error = body.error
  const fields: { errorType?: string; message?: string } = {}
  if (error && typeof error === "object") {
    const typed = error as { type?: unknown; message?: unknown }
    if (typeof typed.type === "string") fields.errorType = typed.type
    if (typeof typed.message === "string") fields.message = typed.message
  }
  if (fields.errorType === undefined && typeof body.type === "string") fields.errorType = body.type
  if (fields.message === undefined && typeof body.message === "string") fields.message = body.message
  return fields
}

// ---------------------------------------------------------------- engage

async function engage(
  event: any,
  base: Record<string, unknown>,
  eventFields: Record<string, unknown>,
  started: number,
  trigger: "R1" | "R2" | "SENTINEL",
): Promise<void> {
  const line = (outcome: string, detail: Record<string, unknown>) => {
    fileLog({
      ...base,
      ...eventFields,
      trigger,
      engaged: true,
      outcome,
      host: null,
      ...detail,
      ms: Date.now() - started,
    })
  }

  let rung: Rung2 | null = null
  try {
    rung = await resolveRung2()
  } catch {
    rung = null
  }
  if (!rung) {
    line("rung2-unconfigured", {})
    return
  }

  const host = rung.host

  let originalBody = ""
  try {
    originalBody = await event.request.clone().text()
  } catch {
    line("rung2-failed", { errorType: "request-body", host })
    return
  }

  let outgoing: string
  try {
    const parsed = JSON.parse(originalBody)
    if (!parsed || typeof parsed !== "object") throw new Error("not an object")
    parsed.model = rung.model
    outgoing = JSON.stringify(parsed)
  } catch {
    line("rung2-failed", { errorType: "request-body", host })
    return
  }

  const url = `${rung.baseURL.replace(/\/+$/, "")}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS)

  let fetched: Response
  try {
    fetched = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rung.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
        "user-agent": USER_AGENT,
      },
      body: outgoing,
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    line("rung2-failed", { errorType: errorClass(error), host })
    return
  }

  // Headers have arrived: never abort mid-body. The runner governs the
  // handed-over stream with its own chunk timeouts.
  clearTimeout(timer)

  const contentType = fetched.headers.get("content-type") ?? ""
  const isSSE = /^\s*text\/event-stream\b/i.test(contentType)

  if (fetched.status !== 200) {
    try {
      await fetched.body?.cancel()
    } catch {
      // ignore
    }
    line("rung2-failed", { errorType: `rung2-http-${fetched.status}`, host })
    return
  }

  if (!isSSE || fetched.body === null) {
    try {
      await fetched.body?.cancel()
    } catch {
      // ignore
    }
    line("rung2-protocol-mismatch", { host })
    return
  }

  // Swap the response in place. Drop the original body, copy content-type
  // only (no length/encoding/transfer headers).
  try {
    void event.response.body?.cancel().catch(() => {})
  } catch {
    // ignore
  }
  event.response = new Response(fetched.body, {
    status: 200,
    headers: { "content-type": contentType },
  })
  line("rung2-ok", { host })
}

// ---------------------------------------------------------------- evaluator

async function evaluate(event: any): Promise<void> {
  const model = modelParts(event?.model)
  // Engage kinds: primary (agent turns) + compaction (autocompact failure is
  // session-fatal). Title/generate stay out: cosmetic, and title 2xx must not
  // touch burst state.
  if (
    (event?.kind !== "primary" && event?.kind !== "compaction") ||
    !/^deepseek.*-free$/.test(model.id)
  )
    return

  const started = Date.now()
  const base: Record<string, unknown> = {
    t: new Date().toISOString(),
    sessionID: String(event?.sessionID ?? ""),
    agent: String(event?.agent ?? ""),
    kind: String(event?.kind ?? ""),
    modelId: model.id,
  }

  const sessionID = String(event?.sessionID ?? "")
  const response: Response | undefined = event?.response
  const status = typeof response?.status === "number" ? response.status : 0
  base.status = status

  // SENTINEL: validation-only forced engagement. Takes precedence over the
  // status taxonomy because the calibration dispatch may complete normally.
  let sentinel = false
  try {
    sentinel = existsSync(SENTINEL_FILE)
  } catch {
    sentinel = false
  }
  if (sentinel) {
    try {
      unlinkSync(SENTINEL_FILE)
    } catch {
      // ignore: one-shot consumption is best-effort
    }
    // §6: any 2xx rung-1 response clears the burst state. The sentinel line
    // itself is the one log line for this event.
    if (status >= 200 && status < 300) bursts.delete(sessionID)
    await engage(event, base, {}, started, "SENTINEL")
    return
  }

  // 5xx: never ladder.
  if (status >= 500) {
    fileLog({ ...base, trigger: null, engaged: false, outcome: "pass-through", host: null, ms: Date.now() - started })
    return
  }

  // Any 2xx rung-1 response clears the burst state for the session. A clean
  // pass-through with no active burst logs nothing.
  if (status >= 200 && status < 300) {
    if (bursts.has(sessionID)) {
      bursts.delete(sessionID)
      fileLog({ ...base, trigger: null, engaged: false, outcome: "pass-through", host: null, ms: Date.now() - started })
    }
    return
  }

  // Parse the error body only for the statuses the taxonomy classifies.
  let fields: { errorType?: string; message?: string } = {}
  if (response && (status === 403 || status === 429)) {
    fields = bodyErrorFields(await readJsonBody(response))
  }
  const extra: Record<string, unknown> = {}
  if (fields.errorType !== undefined) extra.errorType = fields.errorType

  // TRIGGER-R1 (immediate ladder; bypasses the burst gate).
  let r1 = false
  if (status === 402) {
    // In-tree 402 is always QuotaExceeded; no body check.
    r1 = true
    extra.errorType = "QuotaExceeded"
  } else if (status === 403) {
    if (fields.errorType === "FreeTierError" || fields.errorType === "authentication_error") r1 = true
  }
  if (!r1 && (status === 403 || status === 429) && typeof fields.message === "string") {
    if (R1_MESSAGE_RE.test(fields.message)) r1 = true
  }
  if (r1) {
    await engage(event, base, extra, started, "R1")
    return
  }

  // TRIGGER-R2: plain burst 429, cooldown-gated.
  if (status === 429) {
    const now = Date.now()
    let entry = bursts.get(sessionID)

    // Lazy eviction on touch.
    if (entry && now - entry.burstStart > BURST_EVICT_MS) {
      bursts.delete(sessionID)
      entry = undefined
    }

    if (!entry) {
      bursts.set(sessionID, { burstStart: now })
      fileLog({
        ...base,
        ...extra,
        trigger: "R2",
        engaged: false,
        outcome: "pass-through",
        host: null,
        ms: Date.now() - started,
      })
      return
    }

    if (now - entry.burstStart >= BURST_GATE_MS) {
      await engage(event, base, extra, started, "R2")
      return
    }

    fileLog({
      ...base,
      ...extra,
      trigger: "R2",
      engaged: false,
      outcome: "pass-through",
      host: null,
      ms: Date.now() - started,
    })
    return
  }

  // Other non-2xx statuses: never ladder.
  fileLog({ ...base, ...extra, trigger: null, engaged: false, outcome: "pass-through", host: null, ms: Date.now() - started })
}

// ---------------------------------------------------------------- hook

async function onHttpResponse(event: any): Promise<void> {
  const started = Date.now()
  try {
    await evaluate(event)
  } catch (error) {
    // The event stays untouched. Never throw: a rejected promise hook is an
    // Effect defect that kills the model request.
    const model = modelParts(event?.model)
    try {
      fileLog({
        t: new Date().toISOString(),
        sessionID: String(event?.sessionID ?? ""),
        agent: String(event?.agent ?? ""),
        kind: String(event?.kind ?? ""),
        modelId: model.id,
        trigger: null,
        status: typeof event?.response?.status === "number" ? event.response.status : 0,
        errorType: errorClass(error),
        engaged: false,
        outcome: "plugin-error",
        host: null,
        ms: Date.now() - started,
      })
    } catch {
      // last-resort: logging must never throw
    }
  }
}

// ---------------------------------------------------------------- plugin

export const DsLadderPlugin = {
  id: "local.ds-ladder",
  async setup(context: any) {
    await context.session.hook("http.response", onHttpResponse, { providerID: "opencode" })
  },
}

export default DsLadderPlugin
