"""Run an isolated, real Genesis Mesh NA for the Backstage integration lab.

All keys, attestations and policies are generated locally. Existing lab state
is reused on restart, including revocations; no state is silently reset.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Optional source checkouts are read-only, including their __pycache__ trees.
sys.dont_write_bytecode = True

NETWORK = "BACKSTAGE-GENESISMESH-LOCAL"
APP_ID = "backstage-demo"
POLICY_ID = "backstage-secret-rotation"
CONTROLLER_ID = "backstage-controller"
EXECUTOR_ID = "backstage-executor"
SETUP_ID = "backstage-setup"
NA_KEY_ID = "backstage-local-na"


def write_private_json(path: Path, value: dict[str, Any]) -> None:
    """Keep local credentials out of stdout; restrict modes on POSIX."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")


def read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def seed_key(seed: str):
    from nacl.signing import SigningKey

    return SigningKey(base64.b64decode(seed, validate=True))


def public_key(seed: str) -> str:
    return base64.b64encode(bytes(seed_key(seed).verify_key)).decode("ascii")


def fresh_seed() -> str:
    from nacl.signing import SigningKey

    return base64.b64encode(bytes(SigningKey.generate())).decode("ascii")


def create_authority_state() -> dict[str, Any]:
    from genesis_mesh.crypto import sign_model
    from genesis_mesh.models import GenesisBlock, NetworkAuthority, PolicyManifestRef

    na_seed = fresh_seed()
    na_public = public_key(na_seed)
    now = datetime.now(timezone.utc)
    genesis = GenesisBlock(
        network_name=NETWORK,
        network_version="backstage-local-v1",
        root_public_key=na_public,
        network_authority=NetworkAuthority(
            public_key=na_public,
            valid_from=now,
            valid_to=now + timedelta(days=90),
        ),
        policy_manifest=PolicyManifestRef(hash="sha256:backstage-local", url=None),
    )
    genesis.signatures.append(sign_model(genesis, seed_key(na_seed), "root"))
    return {
        "schemaVersion": 1,
        "purpose": "backstage-genesismesh-local-authority",
        "naSeedBase64": na_seed,
        "genesis": genesis.model_dump(mode="json"),
        "controller": {"keyId": CONTROLLER_ID, "seedBase64": fresh_seed()},
        "executor": {
            "keyId": EXECUTOR_ID,
            "seedBase64": fresh_seed(),
            "sovereignId": EXECUTOR_ID,
        },
        "setup": {"keyId": SETUP_ID, "seedBase64": fresh_seed()},
    }


def build_service(state: dict[str, Any], state_dir: Path, base_url: str):
    from genesis_mesh.models import GenesisBlock
    from genesis_mesh.na_service.server import NetworkAuthorityService

    return NetworkAuthorityService(
        genesis_block=GenesisBlock.model_validate(state["genesis"]),
        na_private_key=seed_key(state["naSeedBase64"]),
        key_id=NA_KEY_ID,
        db_path=str(state_dir / "authority.sqlite"),
        operator_public_keys={
            state[name]["keyId"]: public_key(state[name]["seedBase64"])
            for name in ("setup", "controller")
        },
        operator_key_tiers={SETUP_ID: "privileged", CONTROLLER_ID: "standard"},
        boundary_policy_enforcement="required",
        evidence_store="on",
        public_url=base_url,
    )


def admin_post(service, key: dict[str, str], path: str, body: dict[str, Any], status: int):
    from genesis_mesh.crypto.admin_auth import sign_admin_request

    headers = sign_admin_request(
        seed_key(key["seedBase64"]),
        key["keyId"],
        method="POST",
        path=path,
        audience=service.genesis_block.network_authority.public_key,
        body=body,
    )
    response = service.app.test_client().post(path, json=body, headers=headers)
    if response.status_code != status:
        # Do not print response bodies: future responses could contain secrets.
        raise RuntimeError(f"Local bootstrap {path} returned HTTP {response.status_code}, expected {status}")
    return response.get_json()


def bootstrap_fixture(service, state: dict[str, Any], base_url: str) -> dict[str, Any]:
    setup = state["setup"]
    attestation = admin_post(service, setup, "/admin/attestations", {
        "subject_id": CONTROLLER_ID,
        "subject_public_key": public_key(state["controller"]["seedBase64"]),
        "roles": ["role:client"],
        "claims": {"capabilities": ["secret.rotate"], "apps": [APP_ID]},
        "validity_hours": 24,
    }, 201)
    now = datetime.now(timezone.utc)
    policy = admin_post(service, setup, "/admin/boundary-policies", {
        "policy_id": POLICY_ID,
        "description": "Local Backstage lab: rotate only the demo app with a lifetime of at most 30 days",
        "valid_from": (now - timedelta(minutes=1)).isoformat(),
        "valid_until": (now + timedelta(hours=24)).isoformat(),
        "selector": {
            "parent_kinds": ["attestation"],
            "requester_sovereign_ids": [CONTROLLER_ID],
            "capabilities": ["secret.rotate"],
        },
        "gates": [
            {"gate_id": "app", "gate_type": "attestation_claim.v1", "order": 0,
             "config": {"path": "request_parameters.app_id", "claim": "apps"}},
            {"gate_id": "lifetime", "gate_type": "max_value.v1", "order": 1,
             "config": {"path": "request_parameters.lifetime_days", "max": 30}},
        ],
    }, 201)
    admin_post(service, setup, f"/admin/boundary-policies/{POLICY_ID}/activate", {
        "version": policy["version"],
    }, 200)
    admin_post(service, setup, "/admin/evidence/executor-keys", {
        "key_id": EXECUTOR_ID,
        "public_key": public_key(state["executor"]["seedBase64"]),
        "executor_sovereign_id": EXECUTOR_ID,
    }, 201)
    return {
        "schemaVersion": 1,
        "baseUrl": base_url,
        "networkName": NETWORK,
        "naPublicKey": service.genesis_block.root_public_key,
        "naKeyId": NA_KEY_ID,
        "controller": state["controller"],
        "executor": state["executor"],
        "setup": setup,
        "policy": policy,
        "attestation": attestation,
        "appId": APP_ID,
        "resourceId": "local:backstage-demo/api-key",
        "capability": "secret.rotate",
        "maxLifetimeDays": 30,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=Path(".local/authority"))
    parser.add_argument("--port", type=int, default=19443)
    parser.add_argument("--genesis-source", type=Path, help="Optional read-only core checkout instead of installed package")
    parser.add_argument("--bootstrap-only", action="store_true", help="Prepare the local state without serving HTTP")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if args.genesis_source:
        source = args.genesis_source.resolve(strict=True)
        if not (source / "genesis_mesh" / "__init__.py").is_file():
            parser.error("--genesis-source must contain the genesis_mesh package")
        sys.path.insert(0, str(source))

    from werkzeug.serving import make_server

    state_dir = args.state_dir.resolve()
    state_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    state_file = state_dir / "authority-state.json"
    fixture_file = state_dir / "connection.json"
    if state_file.exists():
        state = read_json(state_file)
        if state.get("purpose") != "backstage-genesismesh-local-authority" or state.get("schemaVersion") != 1:
            parser.error("State directory is not owned by this lab")
        if not fixture_file.is_file() or not (state_dir / "authority.sqlite").is_file():
            parser.error("Incomplete local state; use a fresh --state-dir instead of overwriting it")
    else:
        if any(state_dir.iterdir()):
            parser.error("Use an empty --state-dir; existing files are never overwritten")
        state = create_authority_state()
        write_private_json(state_file, state)

    base_url = f"http://127.0.0.1:{args.port}"
    service = build_service(state, state_dir, base_url)
    try:
        fixture = read_json(fixture_file) if fixture_file.exists() else bootstrap_fixture(service, state, base_url)
        fixture["baseUrl"] = base_url
        write_private_json(fixture_file, fixture)
        print(f"Local Genesis Mesh authority: {base_url}", flush=True)
        print(f"Private connection settings: {fixture_file}", flush=True)
        print("Policy enforcement required; evidence store on; state reused on restart.", flush=True)
        if not args.bootstrap_only:
            with make_server("127.0.0.1", args.port, service.app, threaded=True) as server:
                server.serve_forever()
    except KeyboardInterrupt:
        print("Local authority stopped.", flush=True)
    finally:
        service.db.conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
