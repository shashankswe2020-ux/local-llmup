# Spec: Privacy-Preserving Usage Telemetry

> Status: **Draft (v0.2) — architecture, security, and test-strategy feedback incorporated; pending human approval.**
> Last updated: 2026-08-08
> Related: [local-llmup.md](./local-llmup.md),
> [hardware-advisor.md](./hardware-advisor.md), and
> [runtime-performance-benchmarking.md](./runtime-performance-benchmarking.md).

---

## 0. Assumptions and proposed decisions

These assumptions become decisions only when this spec is approved:

1. Telemetry is **pseudonymous**, not anonymous: a random installation UUID is a
   persistent identifier even though it is not a name or hardware serial.
2. Telemetry is enabled by default only after a one-invocation disclosure period
  and explicit opportunity to opt out. The disclosure is persisted before any
  UUID/event exists; events created on a later invocation are not eligible for
  delivery until a subsequent invocation. `DO_NOT_TRACK=1`,
   `LOCAL_LLMUP_TELEMETRY=0`, and CI environments disable it before any event is
   created or sent. Whether default-on is legally appropriate must be approved
   before release; default-off is the fallback if review is incomplete.
3. `recommend`, `can-run`, `doctor`, and `catalog` preserve the deterministic
   offline-advice boundary: they may append a bounded local event after producing
   their result, but they never make a telemetry network request. Queued events
   are flushed only after a later eligible runtime command.
4. Normal command behavior, output, latency budget, and exit status never depend
   on telemetry success. Telemetry configuration commands are the only exception:
   their own local persistence failures are user-visible errors.
5. The client uses native `fetch`, `crypto.randomUUID()`, existing Zod, and
   existing hardware data. No new CLI runtime dependency is required.
6. The ingest service is a separately deployed, provider-isolated service. This
   draft specifies a Cloudflare Worker + D1 reference deployment, but the final
   project-owned HTTPS hostname, Cloudflare account, retention owner, and privacy
   contact must be approved before implementation.
7. Exact custom model names are never sent. A model is sent only when it resolves
   to a canonical id in the shipped offline catalog; otherwise it is `other`.
8. Turning telemetry off deletes the local installation UUID, pending outbox, and
  every owned telemetry quarantine/staging artifact.
   Turning it on later creates a new UUID, so the two periods cannot be linked by
   local-llmup.
9. Raw pseudonymous events are retained for at most 30 days. Ingest suspends if
  that bound cannot be enforced. Identifier-free
   daily aggregates may be retained for 13 months; all-time counters contain no
   installation identifiers.
10. Telemetry never changes `data/models.json`, `data/perf.json`, ranking,
    recommendations, integrity decisions, or runtime lifecycle behavior.

---

## 1. Objective

Add minimal, transparent telemetry that helps maintainers answer:

- How many claimed pseudonymous installations reach the public endpoint, with
  documented abuse/error limitations?
- Which coarse OS, architecture, memory, and GPU-vendor classes are
  common?
- Which public catalog models and backends are selected?
- Where do setup and serving workflows fail, by stable error category?
- Which released versions are actively used and upgraded from?

The feature is successful when maintainers can make product and catalog decisions
from aggregate evidence without collecting user content, machine identity,
precise hardware fingerprints, local paths, network addresses, or raw errors.

### Target users and stakeholders

- Users who want a clear, reversible telemetry choice.
- Maintainers prioritizing hardware, model, backend, and setup support.
- Release engineers measuring upgrade adoption and coarse failure rates.
- Privacy/security reviewers auditing the exact data inventory and retention.

### Non-goals

- Advertising, attribution, cross-product tracking, or user profiling.
- Tracking npm download/install events before the CLI is actually used.
- Collecting prompts, responses, conversation memory, embeddings, benchmark
  evidence, model paths, custom model names, command arguments, or shell history.
- Collecting exact CPU/GPU model, VRAM, RAM bytes, serial numbers, hostnames,
  usernames, home directories, environment values, IP addresses, geolocation,
  or full HTTP headers.
- Crash dumps, stack traces, raw exception messages, or automatic issue uploads.
- Changing offline advice from live telemetry.
- Treating public, unauthenticated telemetry as exact or security-authoritative.

---

## 2. Privacy principles and threat model

### 2.1 Terminology

The user-facing text says **pseudonymous usage telemetry**, not “fully anonymous
telemetry.” The client-generated UUID distinguishes one installation from many
runs but can link that installation's events until opt-out/reset or retention
expiry. Documentation must say this plainly.

### 2.2 Data minimization rules

The payload is an allowlist. Unknown keys fail validation at both client and
server. Code must construct a fresh DTO from approved scalar values; it must not
serialize command options, `HardwareProfile`, process/environment objects, errors,
backend responses, or state files wholesale.

Always prohibited:

- username, hostname, email, account id, IP address in payload/storage;
- home/current-working/model/cache paths or executable paths;
- environment variable names or values;
- CPU/GPU serial, UUID, PCI id, exact model name, driver version, MAC address;
- exact RAM/VRAM/disk bytes or free-memory measurements;
- prompts, responses, memory records, facts, embeddings, benchmark samples;
- arbitrary model strings, repository URLs, endpoint URLs, ports, process ids;
- timestamps finer than the server's UTC day aggregate;
- raw errors, stack traces, control bytes, or command arguments.

### 2.3 Transport-metadata honesty

The client does not include IP address or User-Agent-derived data in the event
object. The network edge necessarily observes source IP and transport headers to
route the request. The service must disable application request logging, never
copy transport headers into storage, disable geolocation enrichment, and use IP
only transiently for edge rate limiting. Provider-level operational processing
must be disclosed in the privacy notice; the product must not claim that no
processor can observe an IP in transit.

### 2.4 Fingerprinting resistance

Hardware is bucketed, and dashboards suppress cohorts with fewer than 10 events
or 5 distinct installation hashes. Exact model ids are limited to public catalog
ids. Queries cannot expose row-level data. Maintainer dashboards show aggregates
only. Combining model, hardware, OS, Node, and version fields is permitted only
inside these suppression rules.

### 2.5 Integrity limitations

The npm client cannot safely hold an ingest secret. The endpoint is therefore
public and telemetry can be spoofed. Results are approximate product signals,
not billing, security, or scientific evidence. Strict schemas, body/event caps,
deduplication, and transient-IP rate limits reduce abuse but do not prove that an
event came from a genuine installation.

---

## 3. CLI surface

Add one subcommand with three required actions:

```text
local-llmup telemetry on
local-llmup telemetry off
local-llmup telemetry status
```

Description:

```text
Manage pseudonymous usage telemetry.
```

### 3.1 `telemetry status`

Text output:

```text
Telemetry: enabled
Effective: disabled (DO_NOT_TRACK=1)
Install ID: present
Pending events: 0
Policy: https://<project-owned-domain>/privacy/telemetry
```

Rules:

- Never prints the UUID itself.
- Performs no network request and creates no telemetry event.
- Reports configured and effective state separately.
- Reports only bounded outbox count, never outbox contents.
- Exit 0 when state is readable; invalid/unsafe config exits 1 with a sanitized
  error and does not repair it silently.
- `configured` is `unset`, `enabled`, or `disabled`. Unset status performs no
  write, reports `installIdPresent:false`, and reports the effective default for
  the current interactive/suppression context.

Optional `--json` output is strict and versioned:

```json
{
  "schemaVersion": 1,
  "configured": "enabled",
  "effective": "disabled",
  "disabledReason": "do_not_track",
  "installIdPresent": true,
  "pendingEvents": 0,
  "policyUrl": "https://<project-owned-domain>/privacy/telemetry"
}
```

### 3.2 `telemetry off`

- Atomically writes `enabled:false` under the owner-only telemetry-state boundary.
- Deletes the local installation UUID, first-run markers, and outbox entries.
- Deletes every safely attributable telemetry state, quarantine, lock, and staging
  artifact; if verified deletion fails, exits 1 and reports that local deletion
  is incomplete rather than printing success.
- Makes no network request, including no deletion beacon.
- Is idempotent and exits 0 when already off.
- Prints: `Telemetry disabled; local identifier and pending events deleted.`

There is no deletion beacon: sending the identifier to request deletion would
create another linkable disclosure channel. Previously ingested pseudonymous raw
rows expire automatically within 30 days and cannot be targeted after the local
id is deleted; identifier-free aggregates cannot be removed per installation.
The command and privacy notice state these limits.

### 3.3 `telemetry on`

- Atomically writes `enabled:true` with `consentSource:"explicit_on"`.
- Creates a UUID v4 with `crypto.randomUUID()` only after the telemetry lock is held.
- Prints the current concise data/retention/control disclosure and policy URL,
  then persists `noticeVersion:1`/`noticeShown:true` with the id.
- Resets first-run state so the next successful functional command records one
  new `first_run` event.
- Performs no network request and creates no event itself.
- Is idempotent: when already enabled with a valid UUID, it preserves that UUID.
- If `DO_NOT_TRACK=1`, `LOCAL_LLMUP_TELEMETRY=0`, or CI suppression is active,
  output says configuration is enabled but effective telemetry remains disabled.

### 3.4 Exit codes

| Exit | Meaning |
| --- | --- |
| `0` | Local telemetry setting/status operation completed |
| `1` | Invalid action, unsafe/corrupt config, lock, or persistence failure |

Telemetry delivery never changes another command's exit code.

---

## 4. Consent, precedence, and local state

### 4.1 Effective-state precedence

Disable wins, in this order:

1. `DO_NOT_TRACK=1`;
2. `LOCAL_LLMUP_TELEMETRY=0`;
3. recognized CI environment (`CI=true` or provider-standard CI marker);
4. noninteractive invocation without prior explicit `telemetry on`;
5. persisted `enabled:false`;
6. otherwise persisted/default enabled state after disclosure.

Only exact documented disable values are recognized. The CI allowlist is
`CI=true`, `GITHUB_ACTIONS=true`, `GITLAB_CI=true`, `TF_BUILD=True`,
`BUILDKITE=true`, and `JENKINS_URL` being present. Environment variables are read
only for suppression; their names/values are never sent. An explicit prior
`telemetry on` permits noninteractive telemetry unless DNT/env/CI still disables
it.

An invocation is interactive only when `process.stdin.isTTY === true`,
`process.stdout.isTTY === true`, **and** `process.stderr.isTTY === true`. Missing,
false, redirected, piped, detached, or mixed TTY states are noninteractive. This
conservative predicate is tested as an eight-combination truth table.

### 4.2 First-use disclosure and choice window

On the first successful **interactive** functional invocation with no telemetry
preference:

1. Print once to stderr after normal command output:

```text
local-llmup uses pseudonymous usage telemetry (coarse hardware, public catalog model, success/failure category). No prompts, paths, serials, or IP address are included in payloads. Disable: local-llmup telemetry off. Policy: https://<project-owned-domain>/privacy/telemetry
```

2. Atomically persist a schema-valid disclosure-only state whose only affirmative
  markers are `noticeVersion` and `noticeShown:true`; it has no installation id,
  outbox event, first-run marker, or last-seen version.
3. On the next successful functional invocation, if not suppressed or opted out,
  create the UUID and append `first_run` after product completion.
4. Never submit events appended by the current invocation. An eligible runtime
  invocation flushes only events that existed before current-event construction,
  then appends current events. The earliest first-run transmission is therefore
  a third invocation, leaving a full invocation to run `telemetry off`.

`--help`, `--version`, CLI parse errors, and telemetry commands are not functional
use and do not create state, notice, or events. The notice contains no ANSI and is
not repeated. `--json` keeps stdout as one JSON document; the disclosure remains
on stderr.

Noninteractive first use creates no telemetry state, notice marker, UUID, or
event. DNT/env/CI-suppressed first use likewise creates nothing unless the user
explicitly runs `telemetry on`; external suppression still prevents collection.
If state creation fails during a normal command, telemetry is disabled for that
invocation and the command still succeeds silently. The user can run
`telemetry on` to obtain a direct persistence error.

### 4.3 Crash-consistent telemetry state and outbox

Telemetry does not alter the strict user preference `config.json` v1. It uses a
separate `~/.local-llmup/telemetry.json`, so backend preferences and telemetry
cannot corrupt or migrate each other. All consent markers, identifier state,
version marker, stable pending event ids, and outbox entries share one atomic
transaction boundary.

Normative shape:

```ts
export type TelemetryStateV1 =
  | {
      readonly schemaVersion: 1;
      readonly enabled: false;
      readonly consentSource: null;
      readonly noticeVersion: 1 | null;
      readonly noticeShown: boolean;
      readonly firstRunRecorded: false;
      readonly outbox: readonly [];
    }
  | {
      readonly schemaVersion: 1;
      readonly enabled: true;
      readonly consentSource: "default_disclosure";
      readonly noticeVersion: 1;
      readonly noticeShown: true;
      readonly firstRunRecorded: false;
      readonly outbox: readonly [];
    }
  | {
      readonly schemaVersion: 1;
      readonly enabled: true;
      readonly consentSource: "default_disclosure" | "explicit_on";
      readonly noticeVersion: 1;
      readonly noticeShown: true;
      readonly installId: string;
      readonly firstRunRecorded: boolean;
      readonly lastSeenVersion?: string;
      readonly serverSuspendedUntilDay?: string;
      readonly outbox: readonly TelemetryEventV1[];
    };
```

Rules:

- Validate UUID v4 and bounded SemVer strings with Zod.
- The strict discriminated union permits an id-less enabled state only for the
  disclosure-only branch and forbids outbox/version/suspension fields there.
- Outbox event ids are generated once inside the same state update as their
  markers. Recovery reuses those ids, giving at-least-once delivery with server
  deduplication and no duplicate logical `first_run`/`upgrade` after crashes.
- Write atomically under `~/.local-llmup`, mode `0600`, directory mode `0700`,
  with no-follow/regular-file/ownership checks and the existing lock discipline.
- A symlink, special file, group/other-writable file, invalid schema, oversize,
  or concurrent mutation fails closed for telemetry commands.
- Never overwrite or “repair” invalid telemetry state during normal use.
- Maximum 128 events, 4 KiB per encoded event, and 96 KiB complete state file;
  append beyond either cap drops the oldest complete outbox event atomically;
  consent/disclosure/version markers are separate fields and never evicted.
- A dedicated telemetry lock has a 10 ms non-blocking budget; normal commands
  skip telemetry if unavailable. Local telemetry work has a 25 ms total budget
  excluding network; budget expiry cancels/skips without product impact.
- A separate owner-only `telemetry-delivery.lock` linearizes cross-process sends
  against `telemetry off`. A flusher acquires it before snapshot/recheck and holds
  it through the bounded request/reconciliation, but never holds the state lock
  during network I/O. `off` acquires the same lease (explicit-command timeout 1
  second) before deleting state/artifacts and holds it until the disabled state is
  committed. Thus a send linearizes wholly before opt-out or observes disabled
  wholly after it; after `off` returns, no old snapshot can transmit. Failure to
  acquire makes `off` fail without claiming completion. Lease metadata includes
  PID/start identity and supports ownership-safe stale recovery.
- Corrupt, oversized, symlinked, special, or unsafe state is renamed only when a
  safe owner-only atomic quarantine is possible; otherwise left untouched. Every
  owned quarantine/staging file is enumerated and deleted by `telemetry off`.
- `off` persists a minimal disabled state after verified deletion so default-on
  cannot silently reactivate.
- No background process or daemon is installed.

### 4.4 Platform filesystem contract

On POSIX, open state/lock/staging files with `O_NOFOLLOW`, require regular files,
same effective uid, safe mode (`0600` files/`0700` directories), stable
descriptor/path device+inode before atomic rename, and an owner-only home/staging
tree. On Windows, reject `lstat().isSymbolicLink()`, resolve and pin the parent
real path, open with exclusive-create for staging, require regular-file descriptor
metadata, compare stable volume/file identity before and after access when Node
exposes it, and rely on the current user's inherited profile ACL rather than
claiming POSIX ownership bits. Junction/reparse parents, identity drift, or an
unavailable required identity check disable telemetry persistence. A bounded
Windows ACL adapter must create/verify a current-user-only DACL on the telemetry
directory and files; inherited broad read/write access fails closed. The adapter
uses a constant platform API/script with argument arrays and `shell:false`, never
places account/path text in telemetry, and has the same 25 ms normal-command
budget (telemetry commands may use a separately bounded 2 s setup check). Normal commands
continue, while telemetry commands return a direct error. Tests cover both
algorithms with injected filesystem metadata and race points. No platform silently
falls back from a required check.

---

## 5. Event protocol

### 5.1 Common envelope

```ts
export interface TelemetryEventBaseV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;       // UUID v4, deduplication only
  readonly installId: string;     // UUID v4, HMACed then discarded at ingest
  readonly version: string;       // SemVer, 1..64 ASCII characters
  readonly os: "darwin" | "linux" | "win32" | "other";
  readonly arch: "arm64" | "x64" | "other";
  readonly nodeMajor: number;     // integer 18..999, no minor/patch
}
```

No client wall-clock timestamp is sent. The service supplies receipt time and
retains only UTC day for analytics. `eventId` is random, never derived from event
content, hardware, process, path, or time.

### 5.2 Coarse hardware shape

```ts
export interface CoarseHardwareV1 {
  readonly memoryGbBucket:
    | "4_or_less" | "8" | "16" | "32" | "64" | "128" | "256_plus";
  readonly gpuVendor:
    | "apple" | "nvidia" | "amd" | "multiple" | "none" | "unknown";
}
```

Memory bytes map to GiB using ceiling division, then: `<=4 → 4_or_less`, `5..8 →
8`, `9..16 → 16`, `17..32 → 32`, `33..64 → 64`, `65..128 → 128`, and `>=129 →
256_plus`. GPU is `multiple` only when more than one distinct recognized vendor
exists; otherwise it uses the existing `HardwareProfile` vendor or `none`.
CPU count and Intel distinction are omitted because existing functional evidence
cannot source them without broadening probes. Hardware values come only from a
profile already collected for the functional command; telemetry never triggers a
new probe. Missing/malformed data maps to an absent hardware object—never a
fabricated value.

### 5.3 Model and backend values

- `model`: exact canonical id only after offline catalog resolution; otherwise
  literal `other`.
- No quantization, local alias, source URL, file name, custom repository, model
  path, or prompt is sent.
- `backend`: one of the stable `TELEMETRY_BACKENDS` values or `unknown`; a drift
  test keeps it aligned with the CLI backend enum.
- Backend endpoint, port, PID, executable, and runtime version are prohibited.

### 5.4 Error categories

Failures map locally to one stable enum:

```ts
export type TelemetryErrorCategory =
  | "validation"
  | "backend_missing"
  | "artifact_acquisition"
  | "integrity"
  | "resource_limit"
  | "port_conflict"
  | "readiness_timeout"
  | "runtime_response"
  | "process_identity"
  | "permission"
  | "filesystem"
  | "network"
  | "cancelled"
  | "unknown";
```

No raw message, error type name, stack, status body, path, URL, or model-supplied
string is retained. Unknown failures map to `unknown`.

### 5.5 Event catalog

| Event | Emission point | Properties |
| --- | --- | --- |
| `first_run` | First successful functional command for an enabled install id | coarse hardware when already available; `command` |
| `command_completed` | After each functional command completes | command enum; `outcome:success\|failed`; optional error category |
| `model_detected` | Successful `recommend` top result or explicit `can-run` catalog resolution | catalog model or `other`; coarse hardware when available |
| `model_selected` | User-requested model resolves for `up`, `switch`, or explicit-model `chat` | catalog model or `other`; backend |
| `setup_success` | `up` completes integrity + readiness | model; backend |
| `setup_failed` | `up` terminates with a categorized error | model/`other`; backend/`unknown`; error category |
| `server_started` | `up` establishes a verified server | model; backend; `ownership:owned\|attached` |
| `upgrade` | Successful functional command sees stored version differ from current | bounded old version; new version |

Rules:

- At most one `command_completed` and one of each applicable domain event per
  invocation.
- A failed command may emit `command_completed` plus `setup_failed`; it never emits
  success events.
- `lastSeenVersion`, stable upgrade event id, and outbox append commit in one
  atomic telemetry-state update.
- Versions are package versions only, never runtime/backend versions.
- Event construction occurs after the product outcome is final and before a
  bounded best-effort flush.

### 5.6 Normative discriminated event union

```ts
export const TELEMETRY_COMMANDS = [
  "recommend", "can-run", "doctor", "catalog",
  "up", "down", "switch", "chat", "migrate", "ls",
] as const;
export type TelemetryCommand = (typeof TELEMETRY_COMMANDS)[number];
export type TelemetryOutcome = "success" | "product_negative" | "failed";
export type TelemetryModel = string; // strict canonical catalog id (1..128 ASCII) or "other"
export const TELEMETRY_BACKENDS = ["ollama", "llamacpp", "mlx", "lmstudio"] as const;
export type TelemetryBackendName = (typeof TELEMETRY_BACKENDS)[number];
export type TelemetryBackend = TelemetryBackendName | "unknown";

export type TelemetryEventV1 =
  | (TelemetryEventBaseV1 & {
      readonly event: "first_run";
      readonly properties: {
        readonly command: TelemetryCommand;
        readonly hardware?: CoarseHardwareV1;
      };
    })
  | (TelemetryEventBaseV1 & {
      readonly event: "command_completed";
      readonly properties:
        | { readonly command: TelemetryCommand; readonly outcome: "success" | "product_negative" }
        | { readonly command: TelemetryCommand; readonly outcome: "failed"; readonly error: TelemetryErrorCategory };
    })
  | (TelemetryEventBaseV1 & {
      readonly event: "model_detected";
      readonly properties: { readonly model: TelemetryModel; readonly hardware?: CoarseHardwareV1 };
    })
  | (TelemetryEventBaseV1 & {
      readonly event: "model_selected";
      readonly properties: { readonly model: TelemetryModel; readonly backend: TelemetryBackend };
    })
  | (TelemetryEventBaseV1 & {
      readonly event: "setup_success";
      readonly properties: { readonly model: TelemetryModel; readonly backend: TelemetryBackendName };
    })
  | (TelemetryEventBaseV1 & {
      readonly event: "setup_failed";
      readonly properties: { readonly model: TelemetryModel; readonly backend: TelemetryBackend; readonly error: TelemetryErrorCategory };
    })
  | (TelemetryEventBaseV1 & {
      readonly event: "server_started";
      readonly properties: { readonly model: TelemetryModel; readonly backend: TelemetryBackendName; readonly ownership: "owned" | "attached" };
    })
  | (TelemetryEventBaseV1 & {
      readonly event: "upgrade";
      readonly properties: { readonly oldVersion: string; readonly newVersion: string };
    });

export interface TelemetryBatchV1 {
  readonly schemaVersion: 1;
  readonly events: readonly TelemetryEventV1[]; // 1..20, unique event ids
}

export type TelemetryAcknowledgementV1 =
  | {
      readonly schemaVersion: 1;
      readonly collectionState: "accepted";
      readonly acceptedEventIds: readonly string[]; // exact unique submitted set
    }
  | {
      readonly schemaVersion: 1;
      readonly collectionState: "disabled";
      readonly acceptedEventIds: readonly string[]; // exact unique submitted set
      readonly suspendDays: number; // integer 1..7
    };
```

Every object level is `.strict()`. Event ids and installation ids are UUID v4.
Versions accept SemVer core plus optional prerelease/build metadata, ASCII only,
length 1..64. Canonical model values must resolve against a generated server-side
allowlist keyed by the exact package `version` already present in the envelope,
or equal `other`; arbitrary 1..128 strings do not pass merely because they match
a character regex. Server deploys support before a client release and retains
each supported release's allowlist for that client's support window.

`product_negative` is a valid command result such as `can-run` returning `no` or
`doctor` returning a completed non-OK report. It is not `failed` and carries no
error category. Parse/validation failures before a typed invocation outcome emit
nothing.

### 5.7 Typed command-outcome boundary

Commands and CLI handlers do not pass errors, options, state, or output to
telemetry. Each instrumented handler creates one strict local observation:

```ts
export type TerminalOutcomeV1 =
  | { readonly outcome: "success" | "product_negative" }
  | { readonly outcome: "failed"; readonly error: TelemetryErrorCategory };

export type ExecutionOutcomeV1 =
  | { readonly outcome: "success" }
  | { readonly outcome: "failed"; readonly error: TelemetryErrorCategory };

export type CommandOutcomeV1 =
  | (ExecutionOutcomeV1 & {
      readonly command: "recommend";
      readonly model?: TelemetryModel;
      readonly hardware?: CoarseHardwareV1;
    })
  | (TerminalOutcomeV1 & {
      readonly command: "can-run";
      readonly model?: TelemetryModel;
      readonly hardware?: CoarseHardwareV1;
    })
  | (TerminalOutcomeV1 & {
      readonly command: "doctor";
      readonly hardware?: CoarseHardwareV1;
    })
  | (ExecutionOutcomeV1 & {
      readonly command: "catalog" | "down" | "migrate" | "ls";
    })
  | {
      readonly command: "up";
      readonly outcome: "success";
      readonly model: TelemetryModel;
      readonly backend: TelemetryBackendName;
      readonly ownership: "owned" | "attached";
    }
  | {
      readonly command: "up";
      readonly outcome: "failed";
      readonly error: TelemetryErrorCategory;
      readonly model: TelemetryModel;
      readonly backend: TelemetryBackend;
    }
  | (ExecutionOutcomeV1 & {
      readonly command: "switch";
      readonly model: TelemetryModel;
      readonly backend: TelemetryBackend;
    })
  | (ExecutionOutcomeV1 & {
      readonly command: "chat";
      readonly model?: TelemetryModel;
      readonly backend?: TelemetryBackend;
    });
```

An invocation observer receives this value only after the command has finalized
its product output and exit status. It never buffers, rewrites, or intercepts
stdout/stderr. Existing command modules may return an additive typed summary;
the CLI catch boundary maps typed errors to stable categories and constructs the
observation. `can-run no` and completed non-OK `doctor` use
`product_negative`. `up` reports `ready` only after integrity, readiness, and
state persistence all succeed; an earlier server start followed by state failure
is `setup_failed`, never success.

---

## 6. Client delivery lifecycle

### 6.1 Eligible network flushes

External telemetry delivery is allowed only after these runtime commands finish:

```text
up, down, switch, chat, migrate, ls
```

The following never contact telemetry infrastructure:

```text
recommend, can-run, doctor, catalog, benchmark, telemetry, --help, --version
```

This preserves deterministic offline advice and prevents benchmark contamination.
Those functional commands may queue events locally after their result; a later
eligible runtime command may flush them.

### 6.2 Flush algorithm

1. Finish functional work and determine product exit status.
2. If effective telemetry is disabled, create/send nothing.
3. Write normal product output and set its exit status.
4. For an eligible runtime command, acquire the 10 ms delivery lease, then read
  and recheck effective enabled state plus an immutable snapshot of the old outbox
  under the state-lock budget. Release only the state lock. Select the largest oldest
  prefix satisfying both 20 events and an encoded complete batch size <=60 KiB.
5. POST that bounded old-event batch to the fixed release endpoint.
6. Apply a 250 ms total deadline covering DNS, connect, TLS, upload, response, and
   body drain; abort and destroy the response body on timeout/overflow.
7. Follow no redirects. Accept only HTTPS and the compile-time project hostname.
8. Read at most 4 KiB response; validate strict acknowledgement schema.
9. Accept only 202 with a strict acknowledgement whose unique ids exactly equal
  the submitted set. Re-read current state under lock and remove by id only from
  that submitted set, preserving concurrent appends. For
  `collectionState:"disabled"`, also set a server-suspension day no more than 7
  days ahead and stop creating/sending events during that period. Release the
  delivery lease after state reconciliation.
10. After flush attempt completes, append current invocation events and marker
  changes in one atomic state update unless the acknowledgement activated server
  suspension; in that case discard current events. Current events are never part
  of the same invocation's request.

Delivery is awaited only inside the 250 ms cap so Node does not silently drop a
fire-and-forget request during process exit. No output, spinner, warning, or log
is emitted for delivery. The delivery lease is released in `finally` after every
success, timeout, malformed response, cancellation, and state-reconciliation
failure.

### 6.3 Failure policy

| Failure | Local behavior |
| --- | --- |
| timeout, DNS/TLS/network, 404, 405, 413, 415, 429, 5xx | retain events; no immediate retry |
| redirect or endpoint identity mismatch | retain; abort body |
| 400 strict schema rejection | drop only submitted batch to avoid poison loop |
| unexpected 2xx, protocol mismatch, non-exact/duplicate/foreign ack ids, malformed/oversized acknowledgement | retain; abort body |
| state/outbox failure during normal command | disable telemetry for invocation; preserve product result |

There is no exponential retry timer or background worker. The next eligible
runtime invocation may make one attempt. Outbox caps bound persistent failure.
Lock/local storage work is additionally bounded by 10/25 ms as specified in §4.3;
budget exhaustion skips telemetry. Thus AC10's latency bound is 25 ms local plus
250 ms network, never the product/global lock timeout.

### 6.4 Fixed endpoint

Production builds contain exactly one HTTPS origin and `/v1/events` path. The
transport constructs a constant `URL`, requires protocol `https:`, exact ASCII
hostname/path, no credentials/query/fragment, sets native-fetch
`redirect:"error"`, and verifies the immutable URL immediately before dispatch.
Users
cannot configure an endpoint through CLI, config, model data, catalog, or remote
response. Tests inject a transport dependency directly; production has no runtime
environment override that could redirect telemetry.

---

## 7. Ingest endpoint

### 7.1 Reference deployment

Reference architecture:

```text
CLI native fetch
  → Cloudflare Worker /v1/events
  → strict validation + transient rate limit + HMAC install id
  → D1 raw_events (30-day TTL)
  → scheduled aggregate job
  → aggregate tables/dashboard (no row-level UI)
```

The Worker/service is not included in the published npm package. The final domain,
account ownership, data region, access group, incident contact, and deletion job
must be configured before client telemetry can be enabled in a release.

### 7.2 HTTP contract

Request:

```http
POST /v1/events HTTP/1.1
Content-Type: application/json
```

```json
{
  "schemaVersion": 1,
  "events": [
    {
      "schemaVersion": 1,
      "eventId": "3df29e50-c4dd-4e3a-b674-1509ef95db04",
      "installId": "5462a48a-16d2-4972-83db-a1aca0bc44df",
      "event": "setup_success",
      "version": "1.2.0",
      "os": "darwin",
      "arch": "arm64",
      "nodeMajor": 22,
      "properties": {
        "model": "llama3.2",
        "backend": "ollama"
      }
    }
  ]
}
```

Response:

```json
{
  "schemaVersion": 1,
  "collectionState": "accepted",
  "acceptedEventIds": ["3df29e50-c4dd-4e3a-b674-1509ef95db04"]
}
```

Normative server rules:

- TLS only; POST only; exact path; no redirects.
- `Content-Type: application/json`; reject compressed request bodies.
- Maximum encoded body 64 KiB, maximum 20 events, maximum nesting/string lengths.
- Reject oversized `Content-Length` before reading; otherwise stream and stop at
  64 KiB before `JSON.parse()`. Do not use an unbounded `request.json()` path.
- Strict Zod validation by event-specific discriminated union; reject unknown
  fields, unknown event names, invalid UUID/SemVer/enums, and non-finite numbers.
- One transaction: validate complete batch before accepting any event.
- Return 202 for accepted/deduplicated events, 400 invalid, 413 oversized,
  429 rate-limited, 405 method, 415 content type, and sanitized 5xx.
- Response body max 4 KiB and never echoes submitted values except accepted event
  ids.
- No cookies, CORS credentials, request-body logs, query parameters, or response
  reflection.

### 7.3 Pseudonymization and deduplication

At ingest, before storage:

```text
install_hash = HMAC-SHA-256(server_secret, install_id)
```

- Validate UUID, compute HMAC with Web Crypto, then discard raw `installId`.
- Store `install_hash`; never store the secret beside analytics data.
- Encrypt/rotate secrets under provider secret management with a documented
  continuity/rotation plan.
- Deduplicate by `eventId` for 30 days; event id is stored separately from
  installation hash.
- Application errors never log payloads or HMAC inputs.
- HMAC keys are purpose-separated and versioned. Rotation intentionally breaks
  longitudinal linkage: new events use the new key id; the old key remains only
  for the remainder of the 30-day raw TTL, is not used to rehash old rows, and is
  then destroyed. Event-id deduplication is independent of HMAC key version.

### 7.4 Rate limiting and abuse

- Apply edge rate limit of 60 requests/minute per transient source IP before body
  processing; do not
  persist the IP or expose it to analytics code.
- Trust only the provider's authenticated edge connection metadata for this
  transient key; ignore client-supplied `Forwarded`, `X-Forwarded-For`, and
  similar headers, and never forward the key into Worker analytics/storage.
- Apply 100 events/day per `install_hash` after validation.
- Enforce provider WAF/request limits, a hard tenant-wide accepted-event/day cap
  of 1,000,000 events, a 30,000,000 raw-row ceiling, anomaly quarantine, and
  spend alerts at 50/80/100%. Changing a cap requires operations/security review.
- Enforce 200,000 total requests/day and 4 GiB encoded ingress/day at the provider
  edge before Worker execution. Select a plan/account with an automatic hard
  telemetry-service spend stop at USD 25/month; if the provider cannot enforce
  it, production ingest remains disabled. Crossing any request/byte/spend cap
  automatically disables collection rather than merely alerting.
- Anomaly quarantine stores aggregate counters/reason/day only—no event payload,
  install hash, IP, header, body, or raw error—and expires within 30 days.
- At the accepted-event/row cap or emergency Worker kill switch, strictly
  validate the bounded batch, return `collectionState:"disabled"` with exact ids,
  store no events, and request a bounded 1..7 day client suspension. Provider-
  edge request/ingress/spend hard stops return 429 without invoking the Worker;
  clients retain events under their local caps.
- Reject batches above limits rather than sampling fields selectively.
- Dashboard labels data “approximate; unauthenticated client telemetry.”
- Telemetry cannot trigger model/catalog, release, security, or billing changes
  automatically.

### 7.5 Retention and access

- Raw event rows, event ids, and install hashes: delete within 30 days, including
  replicas, exports, and provider recovery artifacts according to the published
  provider policy.
- Daily aggregate rows without event/install ids: retain at most 13 months.
- All-time counters may retain only scalar counts/sketches with no reversible
  installation membership.
- Prefer storage-enforced expiry; independently run/test daily deletion and query
  oldest-row age. Alert on the first missed run. If any raw row reaches 30 days,
  suspend ingest until deletion and verification complete.
- Raw tables are accessible only to the ingest/retention service accounts.
  Maintainers receive aggregate views only. Separately approved, time-bounded,
  MFA/SSO-protected break-glass raw access is audit-logged and incident-only.
- Dashboard roles cannot execute raw SQL; access is reviewed and revoked at least
  quarterly.
- No row-level dashboard/export; aggregate queries enforce cohort suppression.
- No sale, ad use, third-party enrichment, geolocation, or model training.
- A published telemetry privacy notice lists fields, purposes, processors,
  retention, controls, and contact.

The installation metric is `claimed active installations (rolling 30 days)`, the
distinct `install_hash` count inside the unexpired raw window after abuse filters.
It is not an all-time install count and not authenticated usage. Daily aggregates
may retain scalar daily-active counts, but summing them is prohibited because one
installation can appear on many days. Dashboards show collection coverage,
rejected/quarantined volume, and the unauthenticated-data disclaimer beside the
metric.

---

## 8. Data and domain boundaries

### 8.1 Offline advice

- `recommend`, `can-run`, `doctor`, and `catalog` make no telemetry network calls.
- Telemetry does not modify command output or ranking inputs.
- `data/models.json` and `data/perf.json` remain curated, cited, offline data.
- Aggregate telemetry may motivate a separately reviewed catalog/performance
  change but is never direct evidence for hardware fit or throughput values.

### 8.2 Runtime and benchmark boundaries

- Telemetry remains outside `BackendAdapter`; adapters do not know installation ids
  or event schemas.
- Runtime endpoint/model payloads are never forwarded to telemetry.
- `benchmark` never queues or flushes telemetry, preserving measurement validity.
- Telemetry delivery uses only the fixed external endpoint; local model servers
  remain loopback-only.

### 8.3 User memory boundary

Telemetry code never imports from `src/memory/`, reads memory stores, or receives
chat messages. `chat` telemetry receives only its command name, outcome category,
canonical catalog model/`other`, and backend enum from the command boundary after
content has been discarded.

---

## 9. Project structure

Proposed CLI files:

```text
src/telemetry/
  protocol.ts        Canonical dependency-light event/batch/ack Zod schemas
  schema.ts          Local state/status schemas
  consent.ts         Effective-state precedence and first-use notice
  store.ts           Atomic owner-only telemetry state and outbox
  collect.ts         Pure allowlisted bucketing/event constructors
  transport.ts       Fixed-origin bounded native-fetch delivery
  client.ts          Outbox + flush orchestration; best-effort boundary
src/commands/
  telemetry.ts       on/off/status command only
```

Proposed service files (excluded from npm `files`):

```text
services/telemetry/
  package.json       Independent Worker scripts/dependencies
  package-lock.json  Independently pinned service toolchain
  tsconfig.json      Worker-only TypeScript boundary
  wrangler.toml      Reviewed non-secret deployment bindings
  generated/protocol.ts  Byte-copied canonical protocol at build time
  generated/catalog-models-by-version.json  Release-keyed model allowlists
  src/worker.ts      HTTP boundary, caps, validation, HMAC, persistence
  migrations/        D1 schema and retention indexes
  test/              Worker contract, privacy, abuse, retention tests
```

Tests mirror source:

```text
tests/telemetry/
  schema.test.ts
  consent.test.ts
  store.test.ts
  collect.test.ts
  transport.test.ts
  client.test.ts
tests/commands/
  telemetry.test.ts
```

`src/telemetry/protocol.ts` is the sole protocol source. It imports only Zod and
declares stable telemetry enums locally rather than importing CLI command or
backend modules. A deterministic service script byte-copies it to
`services/telemetry/generated/protocol.ts`; CI fails when regeneration changes a
checked-in copy. The service has an independent package/lock/tsconfig/Wrangler
build and may depend on Zod and approved Cloudflare dev tooling without adding a
CLI runtime dependency. Root `package.json.files` remains `dist` + `data`; npm
pack-list tests reject service/generated/deployment files.

The release preparation script validates `data/models.json`, sorts/deduplicates
canonical model ids, and adds `{packageVersion, releaseDayUtc, catalogSha256, modelIds}` to
`catalog-models-by-version.json`. CI verifies the catalog hash and rejects an
existing version with different ids. Release ordering is server deploy → staging
probe proving exact package-version/model acceptance → npm publish. Unknown
package versions and models known only to another version are rejected; retained
allowlists remain supported from `releaseDayUtc` through the next 365 complete UTC
days and expire at 00:00 UTC on day 366. The npm publish gate requires the actual
UTC publish day to equal the manifest day. After expiry, the service stores
nothing and returns the exact-id disabled acknowledgement with `suspendDays:7`.
Tests inject the UTC clock at one day before, exactly at, and one day after the
expiry boundary.

After tooling approval, service gates are:

```bash
npm --prefix services/telemetry ci
npm --prefix services/telemetry test
npm --prefix services/telemetry run typecheck
npm --prefix services/telemetry run build
```

---

## 10. Code conventions

- TypeScript strict mode; no `any`.
- ESM `.js` imports, named exports only, explicit exported return types.
- Files `kebab-case.ts`; types `PascalCase`; functions `camelCase`; constants
  `SCREAMING_SNAKE_CASE`.
- Validate telemetry state, event DTOs, batches, acknowledgements, and service
  requests with strict Zod schemas.
- Typed local errors; telemetry delivery errors are absorbed only at the explicit
  client boundary.
- Inject filesystem, clock/day, UUID, hardware input, and transport for tests.
- Never catch broadly inside pure constructors; never include error text in an
  event.
- No new CLI runtime dependency. Cloudflare deployment tooling is ask-first and
  isolated from the npm runtime package.

Illustrative allowlisted constructor style:

```ts
export function createSetupSuccess(input: SetupSuccessInput): SetupSuccessEvent {
  return SetupSuccessEventSchema.parse({
    schemaVersion: 1,
    eventId: input.eventId,
    installId: input.installId,
    event: "setup_success",
    version: input.version,
    os: input.os,
    arch: input.arch,
    nodeMajor: input.nodeMajor,
    properties: {
      model: input.catalogModelId ?? "other",
      backend: input.backend,
    },
  });
}
```

---

## 11. Documentation and user communication

README adds a top-level **Telemetry** section and command-reference entry:

```text
Pseudonymous telemetry

After a one-time interactive disclosure and one-invocation opt-out window,
local-llmup enables pseudonymous usage telemetry to improve hardware,
model, and setup support: package version, OS/architecture, Node major version,
coarse RAM/GPU buckets, public catalog model id, backend, command outcome,
and stable error category. It does not send prompts, responses, paths, usernames,
hostnames, serial numbers, exact hardware identifiers, environment values, or IP
addresses in the payload. The network provider necessarily processes an IP to
route the request, but local-llmup does not retain it for analytics.

Disable and delete the local telemetry identifier/outbox:
  local-llmup telemetry off

Re-enable with a new identifier:
  local-llmup telemetry on

Inspect effective state without networking:
  local-llmup telemetry status
```

Also required:

- command help includes `telemetry on|off|status`;
- privacy notice at stable HTTPS URL before release;
- changelog/release notes announce default and controls;
- first-use notice exactly matches the data inventory;
- docs state that public telemetry is approximate and does not affect advice.

---

## 12. Testing strategy

### 12.1 TDD and boundaries

Write failing tests before implementation. All automated tests mock with `vi.fn()`:

- external network/fetch;
- filesystem/state/outbox operations;
- hardware input;
- UUID generation;
- timers/deadlines;
- service storage/HMAC/rate-limit boundaries.

Vitest never contacts the real telemetry endpoint, Cloudflare, Ollama, or a model.
A separately authorized staging smoke uses synthetic canary ids/events only and
must delete/expire them.

### 12.2 Client unit and integration cases

- Existing user config remains byte-for-byte unchanged; telemetry state validates
  independently.
- Missing state, disclosure-only state, UUID v4 creation, one-time notice, and
  first event not deliverable before the third invocation.
- Noninteractive and DNT/env/CI-suppressed first use creates no state, notice
  marker, UUID, event, or fetch; explicit `on` changes only the documented case.
- `on`, `off`, and `status` idempotence and exact exit/output behavior.
- `off` deletes id/markers/outbox/quarantines safely; re-enable creates an
  unrelated UUID.
- Disable precedence table for persisted state, DNT, explicit env disable, CI.
- Every suppression source blocks transmission of a pre-existing outbox; `off`
  atomically defeats concurrent snapshot/removal/append races and leaves no event.
- Delivery-lease interleavings prove a flush linearizes before `off` or observes
  disabled after it; stale-owner recovery and every `finally` release path are
  covered, and no send begins after successful opt-out.
- `--help`, `--version`, parse failure, and telemetry commands create no event.
- First successful functional command after install-id creation records exactly
  one `first_run`; failure does not.
- Every event's success/failure emission point and no duplicate terminal event;
  `can-run no`/non-OK doctor are `product_negative`, parse failures emit nothing,
  and post-readiness state failure is setup failure.
- Crash injection before/after every state temp-write/fsync/rename proves stable
  first-run/upgrade ids and marker/outbox consistency under at-least-once delivery.
- Stable error-category mapping never contains source error text.
- Model allowlist maps custom/path/repository/unknown values to `other`.
- Memory, GPU, OS, arch, and Node-major bucket boundaries.
- Missing hardware does not trigger a telemetry-only probe.
- Strict schema rejects every prohibited/unknown key and malformed scalar.
- Property/fuzz tests ensure serialized events contain no path-like value,
  control byte, prompt/response fixture, env value, hostname, or raw error.
- POSIX/Windows state algorithms, identity/reparse races, permissions,
  size/count caps, oldest-drop,
  corruption quarantine, atomicity, lock concurrency, and cancellation.
- Malformed, truncated, oversized, unsupported-version, and schema-invalid state
  produces no send, no replacement identity, and deterministic status/error;
  prolonged offline runs stay within 128 events/96 KiB and evict oldest events
  without removing disclosure/consent markers.
- Exact outbox boundaries cover 127/128/129 events and one encoded byte below/at/
  above 96 KiB. After an operator safely repairs invalid state, the original
  identity/outbox resumes without regeneration or duplicate logical delivery.
- Advice/doctor/catalog/benchmark paths make zero telemetry fetch calls.
- Eligible runtime commands make at most one bounded flush after product result.
- 9/10/11 ms lock, 24/25/26 ms local, and 249/250/251 ms network deadline
  behavior with fake monotonic timers; a held product lock is irrelevant.
- Redirect, wrong host, HTTP, timeout, oversized/malformed body/ack cancellation.
- Batch selection respects 20-event and complete encoded-byte caps. Only exact-set
  202 acknowledgements remove submitted ids after a locked re-read; duplicate,
  foreign, partial, concurrent-append, 404/405/413/415, and unexpected-2xx cases
  retain correctly. Only strict 400 drops the submitted poison batch.
- State/outbox/network failures do not change normal output or exit code.
- `--json` stdout remains one valid command document; notice uses stderr.
- No network I/O occurs while a telemetry-state lock is held.
- Clock rollback/forward/timezone and UTC-day boundaries cannot extend server
  suspension or retention; process termination at disclosure, post-output,
  flush, and state-rename checkpoints preserves product and state invariants.
- Invalid UTF-8, Unicode/control/path confusables, extreme numbers, and alternate
  JSON serialization orders fail validation or produce identical allowlisted
  semantics; event HMAC is over UUID text only, not JSON canonicalization.

### 12.3 Service contract and security cases

- Exact method/path/TLS/content-type contract.
- Encoded body, event count, string, nesting, and response caps.
- Unknown fields/events, invalid UUID/SemVer/enums, partial invalid batch reject.
- No partial transaction on invalid batch or storage failure.
- HMAC known vectors; raw install id absent from DB/log/error objects.
- Versioned HMAC rotation breaks linkage intentionally and destroys expired keys.
- Event-id deduplication and per-install/day caps.
- Concurrent duplicate-ingest transactions and Worker/storage restart preserve
  atomic event-id deduplication.
- Per-IP, per-install, global daily, raw-row, emergency-disable, and spend-alert
  threshold behavior with synthetic distributed-abuse fixtures.
- Transient-IP rate-limit adapter never passes IP into analytics persistence.
- Forwarded/client IP headers are ignored unless injected by the explicitly
  configured trusted edge binding; spoofed forwarding headers cannot select a
  rate-limit identity. No client request-signature/timestamp authentication is
  claimed, so signature replay tests are not applicable; event-id dedupe is the
  replay control.
- Request headers, User-Agent, geolocation, body, and error details are not logged.
- Aggregate cohort suppression at 9/10 events and 4/5 installs.
- Storage/daily retention at 29/30/31 days, first-miss alerting, oldest-row
  verification, backup/export policy fixtures, and ingest suspension at breach.
- Service errors and responses never reflect payload values.
- Dashboard/service credentials are absent from source and client artifacts.
- Npm pack-list test proves `services/telemetry/` and secrets are excluded.
- Protocol drift test proves client/service schema versions and hashes match.
- Release allowlist tests verify catalog hash/order, exact package version,
  same-version model acceptance, cross-version model rejection, unknown-version
  rejection, server-before-publish staging gate, and support-window expiry.
- Aggregate roles cannot query raw rows; break-glass is time-bounded/audited; the
  rolling-30-day claimed-install metric cannot be presented as all-time actual
  installations or formed by summing daily counts.
- Provider-attestation expiry, missing evidence, edge/storage partial outage, and
  recovery drills keep ingest disabled until all T0 controls are re-verified.
- A traceability table in the implementation plan maps every normative MUST to at
  least one acceptance criterion/test and every AC back to a spec section.

### 12.4 Staging smoke

Opt-in release smoke:

1. Deploy to isolated staging database/domain with request logging disabled.
2. Send one synthetic valid batch and verify 202/ack.
3. Verify DB contains HMAC install hash, no raw UUID/IP/header/body log.
4. Send invalid, oversized, duplicate, redirected, and rate-limited requests.
5. Verify aggregate suppression and retention deletion with synthetic dates.
6. Delete staging rows and document cleanup.
7. Complete a provider-control attestation for edge/security logs, IP processing,
   region, backups, retention, access roles, and disabled geolocation. This is a
   reviewed operational artifact, not an automated-test claim.

Production smoke never uses a real user's identifier or hardware data.

### 12.5 Verification commands

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Service verification commands must be added once Cloudflare tooling is approved;
they must run separately from CLI package gates and never require production
credentials for unit tests.

---

## 13. Security, reliability, and operations

### 13.1 Client safety

- Fixed HTTPS origin; no redirect; no endpoint override in production.
- 250 ms total timeout and 4 KiB response cap.
- Telemetry state/outbox is platform-safely validated, bounded, atomic, and
  lock-protected.
- No user/model/runtime string enters payload except validated catalog ids/enums.
- No telemetry inside backend adapters, benchmark loops, or advice networking.
- Normal commands fail open with respect to telemetry but fail closed for model
  integrity, process identity, and loopback rules as before.

### 13.2 Service safety

- Strict body/schema/rate/storage caps before expensive work.
- HMAC secret in provider secret store; least-privilege D1 binding.
- No raw request/body/header logging or analytics IP/geolocation.
- Aggregate-only dashboard, cohort suppression, MFA, access review.
- Daily retention job and operational alert.
- Abuse cannot alter catalog, advice, releases, billing, or security controls.
- Before rollout, record provider settings for edge/security/diagnostic logs,
  source-IP handling, data region, backups, recovery copies, retention, and
  encryption at rest for primary rows, replicas, exports, backups, and recovery
  copies, including provider key ownership/rotation.
  Automated service tests prove application behavior; a dated deployment
  checklist/attestation verifies provider controls and is not misrepresented as
  an automated guarantee.
- Deploy through protected environments with short-lived credentials, pinned CI
  actions/tooling, reviewed infrastructure changes, immutable artifact provenance,
  no secrets in untrusted pull-request jobs, audit logs, and documented domain/
  account recovery. Rotate/revoke deploy access on maintainer changes.

### 13.3 Availability

Telemetry is noncritical. Endpoint outage, DNS failure, rate limiting, schema
mismatch, or maintenance cannot degrade product success beyond the fixed 250 ms
post-result cap. The bounded outbox absorbs short outages and drops oldest events
under prolonged failure.

### 13.4 Protocol evolution

- Event and batch schemas carry independent integer versions.
- Additive optional fields require privacy review; unknown fields remain rejected
  until both sides deploy support.
- Deploy server acceptance before releasing a client that emits a new version.
- Retain prior server schema for at least the oldest supported client window.
- Removing or reinterpreting a field requires a new schema version.

---

## 14. Phased rollout

### Phase T0 — Governance prerequisite

- Approve default-on versus default-off.
- Approve Cloudflare Worker/D1, account owner, domain, region, privacy contact,
  retention, and deployment tooling.
- Publish telemetry privacy notice.

### Phase T1 — Local controls, no production delivery

- Dedicated telemetry state/outbox; existing user config remains unchanged.
- `telemetry on|off|status`.
- Event constructors and bounded local outbox.
- Endpoint constant remains disabled at build time.
- Functional commands do not collect/queue events while the build constant is
  disabled; tests exercise constructors directly. `telemetry on` may create the
  local id but no usage history accumulates awaiting a future release.

### Phase T2 — Staging ingest

- Worker endpoint, HMAC, D1 schema, retention, aggregation, suppression.
- Client staging transport through injected build configuration.
- Full synthetic staging smoke and security review.

### Phase T3 — Limited production rollout

- Publish an explicit prerelease version to an npm prerelease dist-tag; only that
  package build has collection enabled. There is no per-user random cohort.
- Verify failure/latency/privacy/retention controls.
- No recommendation or catalog automation.

### Phase T4 — General availability

- Enable newly released stable versions after review; already-published disabled
  clients cannot be remotely enabled.
- Publish aggregate dashboard only if suppression/privacy requirements pass.
- Reassess fields and retention quarterly; remove fields not producing decisions.

Client rollback requires a new patch release with collection disabled. Server
emergency mode immediately acknowledges exact ids with
`collectionState:"disabled"`, stores nothing, and suspends compatible clients for
up to seven days. This limits retries from already-published clients but is not a
remote code/config update. Local `on/off/status` remains available and normal CLI
behavior is unchanged.

---

## 15. Acceptance criteria

### Commands and consent

- **AC1:** `telemetry on|off|status` have the exact state, output, exit, and
  no-network behavior in §3.
- **AC2:** First interactive success persists disclosure only; a later success
  atomically creates the UUID/first event, and no current-invocation event is
  deliverable until another invocation. Help, version, telemetry commands, parse
  errors, failed first use, and unconfirmed noninteractive use create none.
- **AC3:** DNT, explicit env disable, CI, noninteractive-unconfirmed state, and
  persisted opt-out follow disable-wins precedence and produce zero telemetry
  state mutation, events, or fetches except an explicit `telemetry on` state
  write; pre-existing outbox entries remain unsent.
- **AC4:** `off` safely deletes local id/outbox/quarantines; re-enable creates a new unlinkable
  UUID; status never prints the id.

### Data minimization

- **AC5:** Every emitted payload validates against a strict event-specific Zod
  union and contains only fields listed in §5.
- **AC6:** Tests prove prohibited values/keys—including prompts, responses, paths,
  host/user names, environment, exact hardware, custom models, endpoints, raw
  errors, and serial identifiers—never serialize.
- **AC7:** Hardware uses exact bucket rules and only already-available evidence;
  missing evidence remains unknown and triggers no new probe.
- **AC8:** Models are canonical public catalog ids or `other`; failure data is a
  stable category only.

### Determinism and reliability

- **AC9:** Advice, catalog, doctor, benchmark, help, version, and telemetry commands
  make no telemetry network request.
- **AC10:** Telemetry failure never changes another command's stdout, product
  result, or exit status and adds at most 25 ms local plus 250 ms network after
  product completion.
- **AC11:** Telemetry state/outbox follows the platform filesystem contract and is atomic, bounded,
  corruption-safe, and concurrency-tested; no network occurs under its lock.
- **AC12:** Delivery accepts only fixed HTTPS origin, no redirects, capped bodies,
  strict ack, and documented status handling.

### Endpoint and privacy

- **AC13:** Service validates complete batches under all caps before one atomic
  transaction and returns only bounded sanitized acknowledgements.
- **AC14:** Raw install UUID is HMACed then discarded; application tests/staging
  inspection find no raw UUID, IP, headers, body logs, geolocation, or reflection,
  and a dated operational attestation covers unavoidable provider processing.
- **AC15:** Raw pseudonymous data expires within 30 days; identifier-free aggregate
  retention is at most 13 months; first deletion miss alerts and any age breach
  suspends ingest until verified cleanup.
- **AC16:** Dashboard/export is aggregate-only and suppresses cohorts below 10
  events or 5 installation hashes.
- **AC17:** Tests enforce the exact per-IP, per-install, global-day, row, emergency,
  and cost thresholds; telemetry is approximate and barred from automatic
  product/security decisions.

### Events and analytics

- **AC18:** Event tests cover `first_run`, `command_completed`, `model_detected`,
  `model_selected`, `setup_success`, `setup_failed`, `server_started`, and
  `upgrade` at exact success/failure boundaries.
- **AC19:** Aggregate queries expose only claimed rolling-30-day active installs,
  coverage/rejection context, active version, OS/arch, coarse hardware, public
  model/backend, setup outcomes, and error categories without maintainer row
  access or an all-time/actual-install claim.
- **AC20:** Telemetry never writes catalog/performance data or influences ranking,
  fit, throughput, integrity, or runtime lifecycle decisions.

### Documentation and release

- **AC21:** README, CLI help, first-use notice, changelog, and published policy
  accurately disclose fields, pseudonymous id, transport-IP processing, purpose,
  retention, controls, and contact.
- **AC22:** Npm package inspection excludes service code, credentials, deployment
  config, and source maps containing secrets.
- **AC23:** Synthetic staging smoke proves ingest, pseudonymization, dedupe, abuse,
  suppression, retention, and cleanup before production enablement.
- **AC24:** `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`
  pass; service gates pass separately.
- **AC25:** Code review has no unresolved Critical/Important findings and security
  review has no unresolved Critical/High/Medium findings.
- **AC26:** Typed command-outcome tests distinguish success, product-negative,
  execution failure, and setup stages without exposing output/options/errors;
  crash-point tests prove marker/outbox consistency and stable event ids.
- **AC27:** Prerelease rollout, server emergency suspension, new-release rollback,
  and disabled-build no-collection behavior are tested and documented.
- **AC28:** A cross-process delivery lease makes flush and `off` linearizable;
  successful opt-out guarantees no prior snapshot can begin transmission and all
  lease failure/cancellation paths release ownership safely.
- **AC29:** Server model validation uses the generated exact package-version
  allowlist, rejects unknown/cross-version values, and passes the mandatory
  server-before-npm-publish staging gate; after 365 complete UTC days, support
  expires at 00:00 UTC on day 366 with no post-expiry storage.

---

## 16. Boundaries

### Always

- Describe telemetry as pseudonymous and optional.
- Use allowlisted DTO construction and strict validation on both sides.
- Preserve deterministic offline advice and benchmark isolation.
- Keep delivery bounded, silent, and irrelevant to product success.
- Delete local identity/outbox/quarantines on opt-out.
- Aggregate with suppression and enforce retention.
- Mock all telemetry network/filesystem boundaries in CLI tests.

### Ask first

- Default-on activation or any consent-copy change.
- Cloud provider, domain, region, D1/storage, deployment tooling, or billing.
- Any future user-config schema/layout change; this spec uses separate telemetry
  state.
- New event, field, longer retention, lower suppression threshold, or new purpose.
- New runtime/development dependency.
- Public dashboard/export or third-party analytics processor.
- Sending telemetry from advice or benchmark commands.

### Never

- Send prompts, responses, memory, arbitrary arguments, raw errors, paths,
  environment, exact hardware identifiers, or transport metadata.
- Store raw installation UUID or source IP in analytics storage/logs.
- Let telemetry alter advice, integrity checks, process ownership, or exit codes.
- Hide the control, make opt-out network-dependent, or recreate an id while off.
- Use telemetry for ads, sale, enrichment, model training, or individual profiling.
- Put a client secret in the npm package.
- Hit the real endpoint from Vitest.

---

## 17. Draft decisions requiring human approval

1. Default-on after an interactive disclosure-only invocation and full-invocation
  choice window versus default-off explicit opt-in.
2. Cloudflare Worker + D1 as the ingest/storage reference implementation.
3. Final project-owned HTTPS telemetry and privacy-policy hostnames.
4. Dedicated telemetry state/outbox location and filesystem policy.
5. Exact event catalog and inclusion of canonical public model ids.
6. Raw 30-day and aggregate 13-month retention.
7. Cohort suppression thresholds: 10 events and 5 installations.
8. Cloud account owner, data region, maintainer access group, privacy/security
   contact, incident response, and recurring cost owner.
9. Exact request/event/row/ingress/USD hard caps and provider support for automatic
  cost-stop behavior.
10. Windows current-user-only DACL adapter and fail-closed platform support.

Implementation must not begin until this spec and all T0 governance decisions are
approved.
