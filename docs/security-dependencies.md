# Security dependency baseline (22 October 2026 source)

This patch starts from default commit `f3bd733ce1f1b7398d7c1d32f3fd48aea10f2bd9`.
It is a source patch, without deployment, wallet access, trading jobs or data
migration. Node runs on 24.22.1, the workspace uses pnpm 10.34.5, and the separate
frontend uses npm 11.19.1. Existing workflow events, permissions, environment and
secret boundaries are unchanged. The weekly LLM benchmark remains a business
workflow; do not dispatch it, or any trade/review/deploy workflow, as CI evidence.
There is no pull-request validation workflow in the reviewed baseline. The
follow-up adds isolated PR validation as described below; business jobs remain
unchanged.

## Compatible parent changes

- Fastify 5.12.7 uses static 10.1.7, CORS 11.3.1 and websocket 11.3.4. These plugins
  explicitly support Fastify 5. The real WebSocket handler now receives the socket
  directly instead of reading the removed `connection.socket` wrapper. The API
  key policy, route bodies, payloads and financial calculations are unchanged.
- Vitest 4.1.12 replaces the unsupported 1.x copies, with supported Vite 7.3.7.
  The frontend also retains corrected Vite 7, rather than requiring a Vite 8
  migration. The two standalone service npm development locks resolve Vite
  8.3.5 through Vitest's supported range; those graphs were resolved and audited,
  while the selected tests ran through the workspace's Vite 7 cohort.
  Transitive updates stay inside their declared parent ranges.
- node-cron 4.6 removes its old uuid 8 dependency. Existing schedule expressions
  and `schedule`/`stop` call sites stay unchanged. Optimizer uuid moves to 11.1.1;
  its callers continue using `v4()` without changing ID or database contracts.
- TypeScript-ESLint parser/plugin 8.72 replace the parent that pinned vulnerable
  minimatch 9.0.3. They support the retained ESLint 8.57 peer. No out-of-range
  minimatch override or rule suppression is used.
- Application alerts continue using Resend. The unused trader Nodemailer entry
  is replaced by a root development dependency for existing workflow mail scripts;
  their bootstrap pins corrected Nodemailer 10.2.1. No email was sent or tested
  against a provider.
- Node 24 histogram typing uses `ReturnType<typeof monitorEventLoopDelay>`.
  The Recharts equity tooltip retains its numeric value contract through a type
  assertion at the formatter boundary.
  Both are type-only adjustments; timing and currency formatting are unchanged.

## Locks and build consumers

The workspace lock and independent frontend/data-collector npm locks are
regenerated. The recorder now has its own committed npm lock because its active
standalone Dockerfile uses npm. Both standalone images copy their lock and use
`npm ci`. Workspace Dockerfiles copy/build the declared data-collector workspace
dependency before signals, then copy its built output into production stages.
Node bases and pnpm bootstrap are pinned; no floating `pnpm@latest` remains.
Build contexts exclude host dependencies, environments and credentials.

The optimizer image uses Python 3.11.17 and bootstraps hash-verified pip 26.2.2.
Both the image and PR setup verify the wheel's SHA-256 before executing pip:
BuildKit `ADD --checksum` (Dockerfile frontend >=1.6) or CI curl/sha256sum performs
the download/check, then `PYTHONPATH` selects that verified wheel for the first
pip invocation, which installs itself with `--no-index --no-deps`. The installed
pip subsequently consumes the application hash lock. This enforces the verified
bootstrap plan; it is not evidence of an exploited flaw or a measured version
problem in the runner's previously bundled pip. No local image or install was
executed for this bootstrap-only follow-up.
It consumes `services/optimizer-server/requirements.lock` with `--require-hashes`.
Regenerate that universal lock with patched uv 0.13.5:

```sh
cd services/optimizer-server
uv pip compile --python-version 3.11.17 --universal --generate-hashes requirements.txt -o requirements.lock
```

FastAPI 0.136.3, Starlette 1.3.1, AnyIO 4.14.2, Pydantic 2.14.1 and certifi
2026.10.19 form the verified service cohort. Optuna stays on its existing 3.5
storage contract; no studies, persistent records or checkpoints are transformed.
The separate ML pyproject now requires supported Python 3.11 and corrected
framework/CA floors. Its scientific graph remains unlocked and was not installed,
trained or certified by the service compatibility fixtures. Agent/research Python
workflows use patched 3.12.15/3.13.17 and corrected pip/CA bootstrap; those business
jobs were not executed. Requests/urllib3 floors are explicit for the agent client.

## Focused offline evidence

Workspace and frontend frozen installs used disabled lifecycle scripts. The
minimal Python environment contains 21 framework/test packages, constrained to
the service lock, and passes `pip check`; it is not a full 38-package service or
scientific installation. All seven backend TypeScript projects compile. The
independent frontend's TypeScript/Vite production build also passes; its initial
type error was repaired without changing formatter behavior. The sandbox initially
blocked esbuild's ancestor-directory metadata reads, and the same scoped static
build passed with the permitted broader filesystem access. No server ran.

```sh
node node_modules/vitest/vitest.mjs run packages/dashboard/src/api/security-dependencies.test.ts packages/data-collector/src/services/Scheduler.security.test.ts packages/backtest/src/types/RiskProfiles.test.ts --pool=threads --maxWorkers=2 --no-file-parallelism --no-api
python -m pytest security_contracts/test_optimizer_api.py -q -p no:cacheprovider
```

The Node selection passes 43 contracts in three files. It tests the actual
DashboardServer registration path with TCP `listen` and automation startup
stubbed before execution. HTTP injection preserves missing/wrong/correct API-key,
CORS and static directory boundaries. `injectWS` uses paired in-memory streams,
not TCP, and tests the real welcome payload. The prior socket wrapper reproduces
a failed welcome contract and an undefined-readyState exception; the direct
socket adapter passes. The actual scheduler registers/stops real cron tasks under
fake time with initial sync, callbacks, providers and databases blocked. Existing
risk-profile tests exercise pure calculations; no backtest/trading job runs.

Three actual optimizer ASGI contracts pass with the Optuna module replaced by a
synthetic in-memory constructor and HTTP transports denied. They check health,
create/suggest JSON mapping and invalid-input rejection without a study, model,
database or API call. These checks do not establish live trading compatibility.

## Review limits

- Before the DOM follow-up, the four Node locks contained 723 public package/
  version pairs with no findings in the root's fresh query; the earlier 317-item
  advisory corpus was insufficient. The new development graph changes that
  footprint. Root refreshed all four final locks after the DOM addition and found
  no exact-package/version matches. This does not make the repository globally
  vulnerability-free.
- The service's 38 exact Python pairs have no exact-package OSV matches in the
  focused query. This does not cover a separately resolved ML or business script
  environment, system libraries, image layers or deployment configuration.
- The original frontend lint command reported two baseline React Hook diagnostics.
  The follow-up below addresses their lifecycle causes without rule suppressions.
  ESLint 8/9 tooling remains unsupported; the backend's existing lint scripts lack
  repository configuration. A lint migration needs its own configuration review.
- No Docker build, container startup, browser, full suite, scheduled workflow,
  optimization, market-data collection, email, transaction or deployment ran.
  Image compatibility and full hosted verification remain separate pending gates.
  Subsequent standalone frozen installs with lifecycle scripts disabled passed
  for both data-collector (272 packages) and mm-recorder (89 packages), recorded
  in the task result. They do not establish image or startup compatibility.

## PR follow-up: frontend lifecycle and isolated image checks

The original full frontend lint reproduces exactly two diagnostics:
`set-state-in-effect` in AutomationPanel and a self-reference before declaration
in useWebSocket. The status panel now applies state in the HTTP completion
callback and ignores results from a cleaned-up polling subscription. Initial
loading, the 10-second interval, independent failed status reads and the existing
manual Refresh control retain their contracts. API URLs, mutating action
callbacks, strategies and trading parameters are unchanged.

The socket's reconnect callback has a local function name instead of referring
to its own uninitialized Hook binding. A connection already in CONNECTING or
OPEN state is reused. Intentional disconnect clears pending retries and detaches
all socket handlers before closing, preventing a close callback from scheduling
a new connection after cleanup. Explicit disconnect still notifies
`onDisconnect` once for an active socket. Remote close retains the configured
reconnect delay, messages and subscription payloads. Callback/option changes
clean up the previous socket before a replacement is created.

`tests/lifecycle.test.mjs` mounts the actual component and hook with React DOM
and jsdom 30.1.3 (development only, pinned in the frontend npm lock). Its timers,
HTTP and WebSocket are simulated; no actual browser, server or trading code runs.
The initial eight contracts reproduce five socket lifecycle failures and three
passing existing contracts. An additional contract covers a stale HTTP response
from the cleaned-up StrictMode effect. The pre-fix lint log and RED/GREEN
evidence are retained in the task workspace, outside source control.
The stale-response contract also fails against the exact pre-follow-up source:
an obsolete status of 99 replaces the current status of 7. After the fixes, all
nine contracts pass, and the full frontend ESLint command reports zero errors.
The updated frontend frozen install passes with 275 packages and scripts disabled;
TypeScript compilation and Vite production build also pass. The build retains
Vite's asset-size warning (one JavaScript chunk exceeds 500 kB); no bundle-size
threshold or warning is suppressed.

```sh
cd packages/dashboard/frontend
node ../../../node_modules/vitest/vitest.mjs run --config vitest.security.config.ts --maxWorkers=2 --no-api
node node_modules/eslint/bin/eslint.js .
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
```

`.github/workflows/security-pr.yml` accepts only PR opened/synchronize/reopened/
ready_for_review events. It uses a read-only token, per-PR cancellation and
in-job path selection. Draft runs compile/lint/build checks. Ready additionally
runs the selected offline contracts (not the full trading suite), installs the
full optimizer hash lock for service dependency verification, and builds affected
images. No business workflow is dispatched or modified by this follow-up.

The image job builds, never runs or publishes, these actual consumers: root
context for Dockerfile.base, dashboard, trader, data-collector and mm-recorder;
frontend context for its Dockerfile; optimizer-server context for its Dockerfile.
Their RUN instructions install public packages or compile source; none downloads
models, starts a service or calls providers. A single Buildx builder reuses layers
across the selected images. There is no registry login, push, image load, deployment
or runtime health request. Hosted image compatibility remains pending until this
workflow succeeds for the final PR commit. Local Docker builds are not evidence.

The new DOM development graph changes the prior 723-pair Node audit footprint.
Root's fresh query of all four final locks reports zero findings, including the
frontend lock SHA-256
`56280ec896f92266281b4c091f05f16779da64614e24ce401d44f3c93c83dfb6`.
No new union pair count is asserted. The separate ML graph, system/image layers
and deployed behavior remain outside that audit scope. Source/workflow review
passes; actual hosted image and Ready-contract results remain pending.
