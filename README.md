# opencode-deepseek-ladder

An [OpenCode](https://opencode.ai) plugin that adds a **transparent two-rung
model ladder** on top of OpenCode's console free models, so agent threads
survive free-tier deaths (daily caps, quota exhaustion, provider bursts)
without the calling agent ever seeing a failure or a mid-thread model change.

- **Rung 1** — the pinned console free model itself (e.g.
  `deepseek-v4.1-flash-free`). Native OpenCode traffic; no gate work.
- **Rung 2** — any OpenAI-compatible DeepSeek endpoint you point it at,
  resolved **fresh from environment variables at failure time**. Swapping the
  paid provider is a one-line env edit — no config, no restart, no code.

  **IMPORTANT:** failing over to another OpenCode key to bypass free model
  limits is against the TOS and also **will not work**, because the second
  rung is a direct OpenAI call that free Zen endpoints will reject. Failong
  over to OpenCode Go should work, in theory.


**experimental** - the code is not fully human-reviewed. Use with caution.
Released into the public domain under the Unlicense - I am not joining the
debate on whether AI-generated code is copyrightable. Do whatever you want
with this code but beware; I recommend getting your own trusted model to
review it for you. ("I" = Misha Ramendik <mr@ramendik.eu> , the code was 
made in OpenCode with GLM 5.3 Flash and DeepSeek 4.1 Flash; I don't really
understand TypeScript so human review was cursory).

## What it does

The plugin hooks OpenCode's `http.response` event, scoped to the `opencode`
provider and to `deepseek*-free` models. When a response arrives:

| Response | Action |
|---|---|
| 403 `FreeTierError` / `authentication_error` / any 402 / 403-429 with quota-flavored message | **Ladder immediately** to rung 2 |
| Plain 429 burst | Wait out a 60 s per-session cooldown, then ladder (lets OpenCode's built-in retries drain short bursts first) |
| 5xx | Never laddered — built-in retries own them |
| 2xx | Passes through untouched (burst state cleared) |

On engage, the plugin reissues the **identical request body** to your paid
endpoint (only the wire `model` field is swapped) and replaces the original
response with the paid stream. One JSONL receipt line is appended per
evaluated event to `~/.local/share/opencode/ds-ladder.log`.

**Fail-closed contract:** the replacement stream must be
`text/event-stream` with at least one `finish_reason` chunk (OpenCode's
OpenAI-compatible framing). Anything else — a plain-JSON 200, a non-200, a
network error — is refused and the *original* response/failure is passed
through unchanged. The ladder is single-layer; there is no rung 3.

**Scope guard:** hooks fire only for `primary` (agent turns) and `compaction`
(autocompact failure is session-fatal) model requests addressed to
`opencode`-provider models whose id matches `deepseek*-free`. Title
generation, other kinds, other agents, providers, and free SKUs (other model
families) are invisible to it — title 2xx must not touch burst state, and a
failed title is cosmetic rather than fatal.

## Error handling

The plugin sits between the response and OpenCode's own error handling, and
every path ends in exactly one of two states:

- **Replaced** — the engage succeeded; the runner consumes the paid lane's
  stream and never sees the original failure.
- **Passed through** — the original response is left untouched and
  OpenCode's built-in machinery owns it: retryable 429/5xx get the built-in
  retry loop, non-retryable quota errors surface to the caller as usual.

The hook can never itself break a model request: the whole evaluation is
blanket-caught, any internal error leaves the event untouched, and one
`plugin-error` receipt line is written to the log.

**Paid-lane failures surface the *original* error — by design.** All five
rung-2 failure paths (unresolvable env config, unreadable request body,
network error / header timeout, non-200 from the paid endpoint, 200 with a
non-SSE content type) log a receipt line and then restore the original
response, so the free lane's failure flows into OpenCode's normal handling
unchanged. There is no retry of the paid lane and no rung 3: if the paid
lane is also down, you see the error you would have seen without the
plugin. Acceptable and intended — a ladder should not paper over two dead
lanes at once.

Once a swap succeeds, the plugin is out of the picture: a paid stream that
breaks *mid-body* surfaces as an ordinary transport error, the same class
as any provider stream break.

Failures of requests the plugin never evaluates (title generation, other
model families, other providers) are likewise handled entirely by
OpenCode — a failed title is cosmetic — and leave no trace in the ladder
log.

## Requirements

- OpenCode 2.0.x (developed and validated on 2.0.26)
- `bash` available for the env resolution step
- A paid rung speaking OpenAI-compatible `POST /chat/completions` with SSE
  streaming and `finish_reason` (DeepSeek, OpenRouter, a local
  vLLM/llama.cpp server, a gateway, …)

## Install

1. Copy the plugin into your OpenCode plugin directory:

   ```sh
   cp ds-ladder.ts ~/.config/opencode/plugins/ds-ladder.ts
   ```

   It loads automatically (file additions hot-load on 2.0.26; a
   `opencode service restart` is the definitive fallback).

2. Add the three environment variables your login shell picks up (for
   example in a sourced secrets file):

   ```sh
   export PAID_DS_BASE_URL="https://api.deepseek.com/v1"   # up to, excluding /chat/completions
   export PAID_DS_API_KEY="sk-..."
   export PAID_DS_MODEL="deepseek-chat"                    # wire model id, verbatim
   ```

   `PAID_DS_BASE_URL` contract: the full base URL **up to but not
   including** `/chat/completions`. `PAID_DS_MODEL` is used verbatim as the
   `model` field on the wire.

   The secrets file is optional: the path is the visible `SECRETS_FILE`
   constant at the top of the plugin (default
   `~/.config/ai/load-secrets.sh`), and **if the file is absent or
   unreadable there is no error** — the ambient environment of the
   OpenCode process is used instead. Point the constant at your own
   secrets file, or set `PAID_DS_*` directly in OpenCode's environment
   and skip the file entirely.

That's it. The values are re-read from the environment on **every** engage,
so rotating keys or swapping providers takes effect on the next failure with
zero restarts.

### Using OpenCode Go as rung 2

The paid rung can point at OpenCode's own Go endpoint (e.g. the paid
`deepseek-v4.1-flash` SKU). The plugin detects the `opencode.ai` host and
automatically adds the required `x-opencode-session` header — the stable
per-conversation id, taken from the original request (fallback: the
event's session id). The `user-agent` stays the plugin's own
self-identifying name on every host, per the client-identification
contract; no identity headers are forwarded to third-party hosts.

```sh
export PAID_DS_BASE_URL="https://opencode.ai/inference/go/v1"
export PAID_DS_API_KEY="<console service key>"
export PAID_DS_MODEL="deepseek-v4.1-flash"
```

## Self-test

The plugin supports a sentinel file for deterministic validation (no real
free-tier outage needed). Default sentinel path:
`/srv/ssd/tmp/opencode/ds-ladder-selftest` — a hardcoded constant in the
plugin (`SENTINEL_FILE`); edit it to relocate.

- Create the file: the **next** scoped free-model request engages rung 2
  regardless of status, and the sentinel is deleted on consumption.
- With a local mock SSE server as `PAID_DS_BASE_URL`, you can verify the
  whole chain (resolver → paid fetch → stream replacement) by observing that
  the engaged request produced the mock's content, and a receipt line with
  `trigger:SENTINEL, engaged:true, outcome:rung2-ok` in
  `~/.local/share/opencode/ds-ladder.log`.

## Honest limitations

- On engage, the **full request body** (prompts, history, tool outputs) is
  sent to your paid endpoint. Point it at a provider you trust.
- Cost/telemetry remain tied to rung 1: paid tokens are recorded at $0
  against the free SKU's id, and compaction budgeting keeps using the free
  model's limits.
- A console-side SKU rename (model id changes) silently disables the ladder
  (fail-open).
- The plugin's `fetch` is raw — it bypasses OpenCode's proxy and middleware
  layers by design.
- Mid-stream 4xx breakage on the *paid* lane is not recoverable (same as
  OpenCode's own transport); request-start failures are the covered case.

## License

[Unlicense](LICENSE) — public domain, no attribution required.
