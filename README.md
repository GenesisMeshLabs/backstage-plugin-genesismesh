# Genesis Mesh for Backstage: local integration lab

A reusable Scaffolder backend module and a runnable local proof of integration.
The action asks a real Genesis Mesh Network Authority to authorize a secret
rotation, verifies the signed decision, updates a simulated local secret store,
and records signed execution evidence. Backstage runs the actual template task.

## Run locally

Requirements: Node.js 22.18+ (tested with 24.14), Python 3.12+ (tested with 3.14),
and npm. Docker and cloud credentials are not required.

```powershell
cd C:\Source\GenesisMeshLabs\backstage-plugin-genesismesh
npm ci
npm run local:setup
npm run local:start
```

Open **http://127.0.0.1:17007/api/genesismesh-demo/**. Submit a seven-day request
and then the 90-day denial example. The authority's enforced maximum is 30 days.
Only decision IDs, version IDs and evidence status appear in task outputs.

The page is a small development harness served by a separate local backend
plugin. It drives real Backstage Scaffolder tasks; it is not the complete
Backstage frontend or an entity-page UI plugin. The reusable module is in `src/`.

The launcher starts both services and waits for the template to enter the catalog.
Backstage binds to `127.0.0.1:17007`; Genesis binds to `127.0.0.1:19443`.
Press Ctrl+C in the launcher terminal to stop both. Each launch creates fresh
keys and data in a new `.local/demo-*` directory; existing state is not reset.
Startup errors name that run directory, containing `backstage.log` and
`authority.log`. Another program using either port must be stopped or the
development ports changed in `scripts/lab.ts`.

## Validate the integration

```powershell
npm run typecheck
npm run build
npm test
npm run test:integration
```

The integration test launches isolated services on available local ports,
registers the template and action, submits real HTTP tasks, then stops both
services. It checks:

- Scaffolder rejects unauthenticated callers.
- The Genesis action is registered in the real task engine.
- An allowed request creates a local secret version.
- An over-limit request fails without changing that version.
- Exported decisions and execution records verify offline against the pinned root.
- A modified policy fixture is rejected.
- Plugin configuration excludes the privileged bootstrap key.
- Revoking the attestation blocks an otherwise permitted request.
- An authority outage fails closed without a mutation.
- Task events and outputs contain no private keys, authentication token or secret value.

The unit test checks that retrying the same task cannot rotate the secret twice.
Successful integration runs write `.local/integration-results.json`. All test
state remains isolated under `.local/integration-*` for inspection.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/module.ts` | Registers the action through Backstage's backend extension point. |
| `src/action.ts` | Typed Scaffolder input/output, initiator provenance and checkpoints. |
| `src/service.ts` | Verified authorization, serialized execution and signed evidence. |
| `src/connection.ts` | Validates the local fixture and pinned policy/attestation signatures. |
| `src/localSecretAdapter.ts` | Simulated provider, atomic file replacement and retry guard. |
| `dev/` | Local Backstage backend and browser demo harness. |
| `examples/template.yaml` | Template usable by a local Backstage catalog. |
| `scripts/local-authority.py` | Isolated real authority with fresh keys and required policies. |
| `scripts/integration.ts` | Real task/API/authority integration checks. |

## Module installation in a development Backstage instance

The package is private and has not been published. Build it and use a local
package path or `npm pack` for a development instance. Add the package to that
backend's dependencies, alongside its existing Scaffolder plugin, then register:

```ts
backend.add(import('@genesismesh/plugin-scaffolder-backend-module-genesismesh'));
```

Configure backend-only paths to an isolated local authority fixture and a private
state directory, and register `examples/template.yaml` in the catalog:

```yaml
genesismesh:
  connectionFile: /absolute/path/to/authority/connection.json
  stateDirectory: /absolute/path/to/plugin-state
  localDemo:
    enabled: true
    allowServiceInitiators: false
```

Normal integration expects an authenticated Backstage user. The standalone lab
explicitly enables a generated local service principal to exercise the task API
without corporate SSO. User identity is derived from Backstage credentials,
never accepted as template input. The lab's static token is restricted to the
catalog and Scaffolder and stays in a private runtime file; it is not sent to the
browser. Company-specific permission policies and per-user Genesis delegation
mapping still need to be designed before a company rollout.

## Boundaries of this demo

- Genesis Mesh core and SDK are pinned to one exact release (`package.json`, `requirements-local.txt`),
  moved by a Renovate pull request when the next one is published; installed dependencies are locked.
- The module currently permits only a loopback authority and the fixed demo
  resource. Replace the local adapter through the service factory when developing
  a real provider integration, and review endpoint/configuration restrictions.
- A secret's requested lifetime is recorded as metadata. This adapter does not
  grant cloud access, enforce a lease timer, or terminate existing sessions.
- A single backend process owns each plugin state directory. The operation marker
  prevents repeating a task after an uncertain mutation; it intentionally requires
  inspection/reconciliation after a crash rather than silently retrying.
- There is no break-glass fallback. No target operation runs on denial or an
  unavailable/unverifiable authorization response.
- The SDK outbox keeps evidence after submission failure. This first module does
  not run an automatic outbox-flush worker; pending/dead-letter output needs
  operator attention. A production adapter needs reconciliation and recovery.
- All local credentials, databases and secret values are under gitignored
  `.local/`. POSIX creation modes restrict files; Windows uses inherited ACLs.
  Treat this directory as private and do not share it. Share source and the
  redacted integration report instead.
- The public local demo routes are development-only and require same-origin JSON
  for task creation. Never register `dev/demoPlugin.ts` in a company deployment.
- Upstream dependency advisories remain; see [dependency findings](docs/dependencies.md).
  This is a local integration lab, not a production security acceptance.

## Separate sandbox application

The richer demonstration lives in [`../sandbox/tests/backstage-demo`](../sandbox/tests/backstage-demo/README.md).
This directory remains the plugin workspace; the sandbox owns the native Backstage application, sample providers and local operator controls. Its frontend uses the official Catalog and Scaffolder pages, authenticated development guest sign-in, and a Genesis Mesh entity tab. Run it at `http://127.0.0.1:17009/` using the sandbox README; the independent plugin harness remains on port 17007.
The sandbox uses a local package dependency and the original rotation module, plus two reusable APIs exported here:

- `createGovernedExecutor`: provider-independent authorization, pinned policy/attestation verification, serialized execution and evidence outbox. A binding is snapshotted for each request and passed to the adapter so resources retain the exact delegation that authorized them. Reads retain resource context without inventing a mutation record.
- `createGovernedScaffolderAction`: authenticated Backstage identity, validated parameters, checkpointed execution and metadata-only task outputs. Provider authors must keep return values and execution parameters free of secret material and implement durable idempotency/recovery for their own mutations.

The generic executor supports HTTPS authorities and loopback HTTP. This does not change the original demo module's loopback-only configuration. The sandbox demonstrates temporary environment access, read-only data leases, revocation/reissue and evidence verification; it does not add corporate SSO or cloud provisioning to this package.

## Primary references

- [Backstage custom Scaffolder actions](https://backstage.io/docs/features/software-templates/writing-custom-actions/)
- [Backstage backend composition](https://backstage.io/docs/backend-system/building-backends/)
- [Genesis governed actions](https://github.com/GenesisMeshLabs/sdk-typescript/blob/main/docs/governance.md)
- [Local authority details](docs/local-authority.md)
