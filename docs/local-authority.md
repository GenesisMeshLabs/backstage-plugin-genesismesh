# Local Genesis Mesh authority

This lab runs the real `genesis-mesh==1.8.1` Network Authority on loopback.
It creates a separate SQLite database and fresh Ed25519 keys in the specified
state directory. It never reads keys or databases from another Genesis Mesh
installation. `boundary_policy_enforcement="required"` and `evidence_store="on"`
are set explicitly. There is no grant or break-glass fallback.

From the plugin workspace, install the pinned package in its own environment:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install genesis-mesh==1.8.1
.\.venv\Scripts\python.exe scripts/local-authority.py --state-dir .local/authority --port 19443
```

Leave that process running while starting the Backstage development backend or
running integration tests. `GET http://127.0.0.1:19443/healthz` reports health.
Press Ctrl+C to stop. Running the command again preserves keys, policy,
attestation, evidence and revocation state. The policy and attestation expire
after 24 hours; use another empty state directory for a fresh lab. The script
does not delete or silently reset existing state. `--bootstrap-only` prepares
the same state and exits without opening a socket.

The package supplies Flask, Werkzeug, PyNaCl and its other runtime dependencies;
the bootstrap needs no additional Python packages. For deliberate compatibility
testing, `--genesis-source C:\Source\GenesisMeshLabs\genesismesh` imports a core
checkout without writing bytecode there. The installed pinned package is the
default and is the reproducible integration target.

## Private connection fixture

`<state-dir>/connection.json` has this schema; the examples below are placeholders:

```typescript
type LocalConnection = {
  schemaVersion: 1;
  baseUrl: string;                   // http://127.0.0.1:19443
  networkName: string;
  naPublicKey: string;               // pinned genesis root public key, base64
  naKeyId: string;
  controller: { keyId: string; seedBase64: string }; // standard operator
  executor: { keyId: string; seedBase64: string; sovereignId: string };
  setup: { keyId: string; seedBase64: string };      // privileged test setup
  policy: BoundaryPolicy;            // complete signed policy from the NA
  attestation: MembershipAttestation;// complete signed attestation from the NA
  appId: 'backstage-demo';
  resourceId: 'local:backstage-demo/api-key';
  capability: 'secret.rotate';
  maxLifetimeDays: 30;
};
```

The runtime controller uses only `controller` and `executor`. The `setup` key
is for test provisioning and revocation; do not put it in a Backstage template
input, browser response, or frontend configuration. All values are generated
locally. Keep the entire state directory and `.venv/` out of version control.
On POSIX the script creates private JSON files with mode `0600`; on Windows
keep the directory under your account's access controls. Do not share this
fixture or `authority-state.json`: both contain local private keys.

The policy requires an attested `app_id` and caps `lifetime_days` at 30. For the
local action, validate that lifetime is also a positive integer before calling
the NA. The attestation permits only `secret.rotate` for `backstage-demo`.

Use the pinned public root to obtain and verify the authority's key history:

```typescript
const client = new GenesisMeshClient({
  baseUrl: fixture.baseUrl,
  signingKeyBase64: fixture.controller.seedBase64,
  keyId: fixture.controller.keyId,
});
const operatorPublicKeys = await client.na.verifiedKeyHistory(fixture.naPublicKey);
const verify = {
  operatorPublicKeys,
  expectedPolicies: [fixture.policy],
  expectedAttestation: fixture.attestation,
};
```

## Revocation test

Use a dedicated test state directory so this deliberately persistent change does
not revoke the attestation used by an interactive demo:

```typescript
const setup = new GenesisMeshClient({
  baseUrl: fixture.baseUrl,
  signingKeyBase64: fixture.setup.seedBase64,
  keyId: fixture.setup.keyId,
});
await setup.attestation.revoke(fixture.attestation.attestation_id, {
  reason: 'local-integration-revocation-check',
});
```

The next evaluation under that attestation is denied. Keep the original signed
`expectedAttestation` for verification; revocation changes the authority's
current state and does not rewrite that earlier signed document. Restarting the
authority preserves the revocation. A successful denial demonstrates that a new
operation cannot begin under that attestation. It does not undo a completed
secret rotation or terminate an unrelated existing connection.

This authority is a local development server bound to `127.0.0.1`. It is not
a production deployment or a corporate identity integration. The local adapter
must still verify decisions and enforce its operation boundary.
