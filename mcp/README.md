# openGym MCP server

An MCP server for managing openGym from an AI client. Three connection modes share the same tools:

- **HTTP OAuth for ChatGPT:** a remote `/mcp` endpoint with per-user sign-in, consent, CIMD,
  PKCE and rotating refresh tokens. See the HTTP setup below.
- **Local analytics:** the existing nine training tools plus overview, batch reads and read-only workflows,
  reading your `data` directory.
- **Authenticated API:** 91 tools including combined training workflows, typed API operations, profile editing and
  execution of all **68 documented API operations**. Connect to a local or remote openGym instance
  with a paired-device bearer token. The API enforces the account's permissions, admin access,
  feature flags, throttling, and session revocation.

API mode can create, edit and delete routines, completed workouts and sets, weigh-ins, custom
exercises, plans, rotations, equipment and settings. Its API gateway also covers media uploads and
downloads, notifications, coach jobs/configuration, account/passkey management and admin operations.
An admin token gives the agent the corresponding administrative powers, including deleting users.

**Device boundaries:** running workouts (`active`) are deliberately excluded from server sync.
The MCP cannot press a phone's UI buttons, operate its native timers or permissions, or create a
hardware passkey without a device completing the WebAuthn ceremony. Finished workout logs can be
created and edited. Push and coach operations can trigger external work and cost, subject to the
server's existing controls. A requested notification or coach job is not proof of delivery/completion.

## Install

Requires Node 22.13+ and the repository's sibling `frontend/src/lib` and `api/openapi.yaml` files.
No extra container is needed.

```sh
cd mcp
npm ci
```

## Connect ChatGPT over HTTP/OAuth

Run the MCP service against one configured OpenGym instance. Each user signs in by creating a
one-time pairing code in their OpenGym app and entering it on the MCP sign-in page. The service
redeems it, verifies the account, and keeps the paired bearer token encrypted on the server.
ChatGPT receives separate, audience-bound MCP OAuth tokens. No shared `OPENGYM_TOKEN` is used
in HTTP mode; setting one is a startup error.

Configure the MCP process:

```dotenv
MCP_TRANSPORT=http
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3001
OPENGYM_URL=http://127.0.0.1:3000
BETTER_AUTH_URL=https://gym-mcp.example.com
BETTER_AUTH_SECRET=<openssl rand -hex 32>
DATABASE_PATH=./data/opengym-mcp.sqlite
```

`OPENGYM_URL` is the fixed backend origin reachable from the MCP process. `BETTER_AUTH_URL`
is the public HTTPS MCP origin. Forward that host to the MCP port using your HTTPS reverse
proxy, preserving the public Host header. The canonical origin comes from configuration;
forwarded headers cannot change the OAuth issuer or redirects. There is no browser CORS API.
The sign-in page instructs users to get a pairing code from their existing OpenGym app; it
never asks for passkey private keys or the OpenGym server's session-signing secret.

Then start `npm start` from `mcp/`, and add `https://gym-mcp.example.com/mcp` to ChatGPT with
**OAuth + CIMD**. If asked for scopes, use `openid offline_access opengym:tools`. No manually
entered client secret is needed for CIMD. Sign in with an OpenGym pairing code and approve the
client's access. Other OAuth clients can be created from a signed-in browser session through
Better Auth's `/api/auth/oauth2/create-client`; anonymous dynamic registration is disabled.

Public discovery endpoints:

- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server/api/auth`

The resource is `<BETTER_AUTH_URL>/mcp`; the issuer is `<BETTER_AUTH_URL>/api/auth`.
The HTTP transport is stateless Streamable HTTP, using the existing MCP SDK 1.x protocol
support. Unlike the current Spotify MCP's SDK 2.x transport, it does not require clients to
speak revision `2026-07-28`. Only the validated token subject selects an OpenGym connection;
tool arguments cannot change that selection. Every MCP request revalidates the backend
session, so expiry, account disablement, and OpenGym's **sign out everywhere** stop access.
Backend sessions are renewed through `/api/me` and persisted encrypted. OAuth access tokens
last 15 minutes; refresh grants rotate with no reuse grace window. OAuth revocation prevents
future refreshes; a previously issued access token can last until expiry while the OpenGym
connection remains valid. Disconnecting on the MCP home page removes that connection for
all clients. Signing out of the browser alone only ends that browser session. Re-pairing the
same account restores its connection, so existing unexpired OAuth grants can work again;
revoke unwanted grants as well when removing a client permanently.

OAuth state, grants, consent, signing keys, rate limits and encrypted paired tokens persist in
SQLite. Keep one replica with a persistent local disk and preserve `BETTER_AUTH_SECRET`.
Back up using SQLite's online backup facilities, or stop the MCP service before copying its
database and WAL files together. Losing/changing the auth secret requires reconnecting users.
The service limits auth bodies to 64 KiB and MCP bodies to 64 MiB to accommodate binary media.
Auth throttling uses the actual socket peer; behind a reverse proxy, users share that peer's
rate-limit budget. HTTP API responses that issue a `token` have that field redacted from MCP
results; backend bearer tokens never appear in browser session JSON.

### Optional container

From the repository root, set `MCP_PUBLIC_URL=https://gym-mcp.example.com` and a random
`MCP_AUTH_SECRET` in your shell or `.env`, then run:

```sh
docker compose -f docker-compose.yml -f docker-compose.mcp.yml --profile mcp up -d --build mcp
```

The optional service connects to `api` internally, persists auth in the `mcp-data` named
volume, and binds host port 3001 to loopback for an HTTPS reverse proxy. `MCP_PORT` changes
that host port. It runs as an unprivileged user and exposes a health check. The default
OpenGym stack remains unchanged when the override/profile is not used.

## Connect a local stdio client with API access

1. In the running openGym app, sign in and open Settings → **Pair the mobile app**.
2. Redeem the displayed one-shot code within five minutes. This consumes the pairing code;
   use a separate code when pairing a phone.

   ```sh
   curl --fail-with-body https://gym.example.com/api/pair/redeem \
     -H 'Content-Type: application/json' \
     --data '{"code":"YOURCODE"}'
   ```

3. Put the returned `token` in your MCP client's environment configuration:

   ```json
   {
     "mcpServers": {
       "opengym": {
         "command": "node",
         "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
         "env": {
           "OPENGYM_URL": "https://gym.example.com",
           "OPENGYM_TOKEN": "<paired bearer token>"
         }
       }
     }
   }
   ```

`OPENGYM_URL` is the origin, without `/api` or a subpath. For local development it can be
`http://127.0.0.1:3000`; use HTTPS across networks. Credentials stay in the MCP process environment
and the Authorization header. Redirects are refused. Missing or invalid API configuration fails
startup instead of falling back to a local profile.

Treat the token like a signed-in device: it has the same account access and session expiry
(`SESSION_DAYS`, default 90). **Sign out everywhere** revokes it; pair again after expiry or
revocation and restart the MCP client. The stdio bridge does not persist session renewals (HTTP mode does).
The gateway intentionally returns API response bodies, including credentials from operations that
issue them; request those operations only when you intend to give the AI client those results.

In this mode the MCP transport is stdio. `OPENGYM_URL` points to the ordinary application HTTP
API; HTTP OAuth clients instead connect to the separate public MCP origin described above.

## Profile tools

| Tool | Purpose |
|---|---|
| `get_profile` | Complete synced document, `rev`, and `state._wid` |
| `edit_profile` | Atomic targeted edits; reads the current revision internally, optional expected-revision guard |
| `search_exercises` | Paginated search of the bundled catalogue and the account's custom exercises |
| `list_api_operations` | Discover all server operations, optionally filtered by text |
| `get_api_operation` | Request/response contract and referenced OpenAPI components |
| `call_api_operation` | Execute an operation with JSON or binary input |

For explicit profile changes, call `edit_profile` directly: it reads and conditionally saves the latest
document internally. For changes based on a previously reviewed snapshot, send `expected_rev` and
optionally `expected_wid` to reject intervening changes. Example of the guarded form:

```json
{
  "expected_rev": 12,
  "expected_wid": "<state._wid from get_profile>",
  "edits": [
    {
      "action": "upsert",
      "collection": "routines",
      "record": {
        "id": "push-a",
        "name": "Push A",
        "ex": [{"id": "<id from search_exercises>", "sets": 3, "reps": 8, "weight": 40}]
      }
    },
    {"action": "set", "path": ["week", "1"], "value": "push-a"},
    {"action": "set", "path": ["dayPlan", "2026-10-21"], "value": "rest"},
    {"action": "upsert", "collection": "bodyweight", "record": {"d": "2026-10-20", "w": 80}}
  ]
}
```

- `set` and `unset` use object-key path arrays. All synced profile fields are accessible,
  including fields beyond the representative OpenAPI State schema. Paths do not traverse arrays;
  supply the array in full, or use record operations.
- `upsert` merges supplied top-level record fields by `id`, or by `d` for bodyweight.
  Nested arrays/objects supplied in a record replace that field. Use IDs from reads/search;
  assign a stable new ID when creating a record.
- `remove` takes `collection` and `key`; a missing record is an error. Named record collections
  are `routines`, `workouts`, `bodyweight`, `customEx`, `equipProfiles`, and `gymCards`.
  Other collections can be changed through `set`.
- When supplied, an expected revision/write-id mismatch refuses the batch. Read again and review the changes before retrying.
  No automatic write retries occur. A race after the read is caught by the API's conditional PUT.
- Writes preserve unrelated fields and travel through the running API's cache, atomic write,
  edit stamps and deletion records. They never modify JSON files behind its back.
- `active` and sync/reset metadata cannot be edited through `edit_profile`. Changing `unit`
  without converting existing weights is refused. Use the app's conversion control or the
  documented `putData` operation with an explicitly converted full document.
- The state schema is extensible; the bridge checks edit structure and basic collection shape,
  not every domain rule. Read existing records and the API contract before constructing them.

For server operations, prefer a typed `api_<operationId>` tool (for example `api_getConfig` or
`api_adminUsers`). Its input schema describes the request, so no discovery call is required.
For extended documentation, discover an ID and inspect its full contract on demand. For example,
`list_api_operations` with `search: "admin"` lists administrative operations;
`get_api_operation` explains their parameters. Invoke `call_api_operation` with `operation_id`,
optional `path`, `query` and `body`. Binary uploads use `base64` and `content_type`; downloads
return `content_type` and `base64`. HTTP errors return MCP `isError`, status and the API response,
including conflict or throttling details. `putData` always requires `baseRev`.

Operation discovery is generated directly from `api/openapi.yaml`, avoiding a second hand-written
route list. The running API version should match this checkout's contract. Responses and permissions
come from the connected server, so a disabled feature may return 404 or a non-admin may return 403.

## Minimize model turns

Choose the shortest path for the user's intent:

| Intent | Tool |
|---|---|
| Training check-in / dashboard | `get_training_overview` |
| Multiple independent analytics/API reads | `batch_read` |
| Multiple exercise name/ID lookups | `resolve_exercises` |
| Create routine, resolve exercises and assign days | `save_routine` |
| Search and add exercises without replacing other rows | `save_routine` with `exercise_mode: "append"` |
| Change prescriptions or remove named exercises | `save_routine` with `exercise_mode: "update"` / `"remove"` |
| Assign routine names/IDs to weekdays/dates or a floating queue | `set_schedule` |
| Log a completed session and optional weigh-in | `log_workout` |
| Routine copy/delete/swap/reorder, history edits, rotation, units, measurements, imports | `apply_training_actions` |
| Several explicit settings/record changes | One `edit_profile` batch |
| A known server operation | Its `api_<operationId>` tool |
| One operation needs another's result | `run_workflow` with result references |

`save_routine` upserts by `routine_id` or a unique exact routine name. Supply a name when creating;
when updating by ID it can preserve the current name. `exercise_mode` defaults to `replace` for
complete plan rewrites. `append` preserves existing rows; `update` merges supplied prescription
fields; `remove` removes selected exercise rows. For update/remove, searches are restricted to the
routine's existing exercises. Repeated rows for the same exercise require an explicit full replacement
instead of guessing which row to edit. All exercise matches resolve before one conditional write.
`set_schedule` similarly resolves every routine before writing the schedule. Missing/ambiguous names
return `needs_selection` and make no changes. `first_match: true` opts into selecting the first
exercise result; use it only when the user accepts that choice.

Common prescription/set fields appear in tool schemas so no profile inspection is needed just to
learn their shape. Additional fields remain supported. `log_workout` takes exercise references plus
set rows (`w`, `r`, `done`, or timed/cardio fields), uses the profile's weight unit, and accepts known
start/end epoch milliseconds. Supply a stable `workout_id` when updating or avoiding duplicate IDs.

`apply_training_actions` runs ordered actions on a private draft with one fresh read and one
revision-guarded write. Any failure discards the entire batch; no automatic replay occurs after a
conflict. It reuses the app's pure helpers for routine copying/deletion (including schedule cleanup),
exercise swaps, workout editing/deletion/date/duration changes, rotation save/start/restart/stop and
refill, kg/lb conversion, measurement normalization, CSV imports, and shared-plan imports. Slot
indices are zero-based; reorder requires a complete permutation. Measurements use canonical cm
regardless of the weight unit. Shared-plan imports merge routines; `schedule: true` replaces the
fixed week using the imported IDs. CSV import keeps existing days, matching the app's import rules.

`log_workout` now uses the same completion boundary as the workout screen: completed entries,
volume, PRs, custom muscle snapshots, remembered working loads and owned-rotation refill are
computed together. Set `backfill: true` for historical entries: they are inserted chronologically,
rebuild relevant PRs, and leave confirmed working loads alone. Existing IDs use the app's history
editor, which repairs remembered loads after corrections. Change a saved workout's date/duration
with the corresponding training actions, rather than changing `log_workout` timestamps.

The official APK needs no rebuild: these operations write its existing synchronized profile format.
The fork's workout screen calls the extracted completion helper too. This is not a claim that every
screen action has a dedicated domain operation: custom exercise/equipment/settings changes remain
available through profile editing and the typed API. Raw edits intentionally bypass derived-state
rules; prefer domain actions for training changes. `get_profile` returns all synced fields, including
advanced set metadata and media references; friendly workout readers also retain advanced entry/set
fields. Device-local active sessions, timers, local notifications, unsynced edits, rendering, local
backup files and mobile OS integrations are outside remote control. Planning defaults to the profile
reminder timezone (UTC if absent); `move_workout` wall time uses the MCP server timezone.

Example: copy a routine, convert all stored weights and record a check-in in one call:

```json
{
  "actions": [
    { "action": "copy_routine", "routine_id": "push-a", "name": "Push B" },
    { "action": "convert_unit", "unit": "lb" },
    { "action": "save_measurement", "date": "2026-10-20", "entry": { "waist": 82 } }
  ]
}
```

Example: find an exercise, append it to Push A, then preview the resulting session in **one call**:

```json
{
  "steps": [
    {
      "id": "save",
      "tool": "save_routine",
      "arguments": {
        "name": "Push A",
        "exercise_mode": "append",
        "exercises": [{
          "exercise": {"query": "<exercise name>", "equipment": "barbell"},
          "prescription": {"sets": 3, "reps": 8, "weight": 40}
        }]
      }
    },
    {
      "id": "preview",
      "tool": "preview_session",
      "arguments": {"routine_id": {"$ref": "save#/routine/id"}}
    }
  ]
}
```

`run_workflow` derives dependencies from references and also accepts `depends_on: ["step_id"]`.
References use JSON Pointer paths into successful tool results; they cannot access process state or
credentials. Independent reads run up to four tool steps concurrently. Writes execute sequentially;
for a single atomic multi-record change, prefer `edit_profile` or a combined training tool. Unknown
tools, cycles, invalid references to step IDs, and errors in reference-free arguments are rejected
before any effects. Arguments containing result references are fully validated once resolved. Each
step returns `ok`, `error`, `needs_selection`, or `blocked`; a failed/ambiguous dependency blocks its
children and independent branches continue. Successful earlier writes remain if a later step fails.
Nested workflows and batches are excluded. Reads that must observe a write must depend on it.

`batch_read` accepts up to 50 `{tool, arguments}` operations, returns results in input order, and
isolates failures. It excludes all write tools and the generic API gateway; use typed `api_<GET>`
tools for API reads. Per-call GET memoization shares a profile/identity snapshot and identical API
reads, including failed reads. A write invalidates the snapshot for subsequent dependent reads.
Caches never persist across MCP calls or accounts. HTTP reuses the identity already validated by
the auth middleware rather than immediately fetching it a second time. Native parallel MCP calls
also remain supported, but separate invocations do not share a profile cache.

### Performance scenarios

Run `npm run benchmark:turns` from `mcp/`. The generated
[benchmark report](benchmarks/turn-performance.md) and [JSON measurements](benchmarks/turn-performance.json)
compare 12 scripted workflows, including a three-action domain batch. Baselines already parallelize
independent reads. Regression tests assert tool-call counts, dependency rounds, backend request
counts, concurrency bounds, failure behavior and matching final state. They avoid wall-clock
thresholds. Benchmark timings are medians with a simulated request delay; no LLM inference or live
ChatGPT latency is measured. Authentication, TLS and real network/provider behavior are excluded.

A tool invocation is not necessarily a model turn: six independent reads can already fit in one
parallel interaction round. Batching those reduces request duplication; combined writes and result
references remove actual dependency rounds. Exposing all 68 typed API operations also increases
initial tool metadata; descriptions use summaries and keep long documentation on demand.

## Existing training tools

| Tool | Purpose |
|---|---|
| `list_routines` | Saved routines and exercise counts |
| `get_routine` | Stored routine prescriptions |
| `preview_session` | Opening set rows after progression and history are applied |
| `get_week_plan` | Upcoming schedule, queue, pins and overrides |
| `list_workouts` | Recent completed sessions |
| `get_workout` | Full set-by-set session breakdown |
| `get_bodyweight` | Weigh-ins, goal and deltas |
| `estimate_1rm` | Exercise estimates and PR table |
| `muscle_balance` | Training load by muscle |

These reuse the same pure functions as the frontend. `get_routine` reports stored values;
`preview_session` reports what starting the routine would prescribe. Ask the latter before naming
a suggested opening weight. In API mode each analytics call fetches a fresh profile; an asynchronous
context keeps the snapshot separate from other calls. This adds API round trips relative to local mode.

## Local read-only mode

Omit both API variables. The server reads `state-<uid>.json` and the profile identity from `db.json`.
It exposes 12 read-only tools (nine training tools plus overview, batch reads and workflows) and
cannot write data.

```sh
OPENGYM_DATA=/absolute/path/to/openGym/data OPENGYM_UID=<uid> node src/index.js
```

`OPENGYM_DATA` defaults to `data` under the working directory. A single profile is auto-detected;
set `OPENGYM_UID` for multi-profile directories. Local mode never exposes passkey material,
push credentials or session secrets. It uses a watcher and mtime fallback to refresh reads.

## Verification

```sh
# The real API integration test needs the API dependencies as well.
npm ci --prefix ../api --omit=optional
npm test
npm run check:node-loadable
```

Tests include existing analytics fixtures, API catalogue coverage, transport/authentication,
profile edit structure, conflict refusal, context isolation, and an actual MCP stdio client talking
to a disposable real API instance. The integration test checks stored edits and deletion stamps and
admin denial, binary media round trips, and local read-only compatibility. HTTP tests cover
OAuth discovery, CIMD metadata registration, pairing/replay, consent, PKCE, token tampering,
scope enforcement, concurrent user isolation, profile writes, refresh rotation, database restart,
body limits, and backend/global disconnect revocation. It does not exercise real passkey hardware, mobile controls, notification delivery,
provider credentials or coach execution. Nix packaging includes the OpenAPI contract as well as the
shared frontend helpers.

## License

AGPL-3.0-or-later, same as openGym.
