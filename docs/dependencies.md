# Dependency review

Snapshot: **2026-10-24**, after installing `better-sqlite3@12.11.1` and applying the `infinispan > urllib@4.9.1` override.

This repository is a **local integration lab**. The development Backstage server binds to `127.0.0.1`, uses an in-memory SQLite database, loads the supplied local template, and uses a local service credential. Its configuration does not establish readiness for installation into the company's Backstage instance. Review the dependency tree, authentication, permissions, deployment configuration, and support ownership before that installation.

## Current audit

The following commands were run against the installed lockfile:

```powershell
npm audit --json
npm audit --omit=dev --json
```

| Dependency scope | Moderate | High | Critical | Total |
| --- | ---: | ---: | ---: | ---: |
| Complete local lab | 20 | 15 | 0 | 35 |
| Plugin runtime dependencies (`--omit=dev`) | 14 | 2 | 0 | 16 |

These totals count affected packages, including ancestors of vulnerable dependencies. They are not counts of distinct vulnerabilities. The runtime tree contains four root advisories; the complete tree contains eight. Audit results describe package versions, not proven exploitability of this lab.

The Backstage backend packages are development dependencies of this plugin package, but they execute when the local lab starts. Their classification as development dependencies does not make their findings irrelevant. The plugin's eventual host application will have its own dependency tree and must be audited independently.

## Runtime advisory families

All four originate through Backstage's integration dependencies. There is no direct Genesis Mesh SDK advisory in this audit snapshot.

| Package and installed version | Finding | Fixed version / constraint |
| --- | --- | --- |
| `@azure/msal-node@6.0.1` | Authorization-code flow can disclose parameters to an attacker-controlled endpoint. | Fixed in `7.1.0`. `@azure/identity@4.14.0` requests `^6.0.0`, so the fix crosses its declared dependency range. [Advisory](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) |
| `@octokit/plugin-paginate-rest@6.1.2` | Regular-expression denial of service in pagination. | Fixed in `9.2.2`; crosses the installed major version. [Advisory](https://github.com/advisories/GHSA-h5c3-5r3r-rr8q) |
| `@octokit/request@6.2.8` | Regular-expression denial of service in request handling. | Fixed in `8.4.1`; crosses the installed major version. [Advisory](https://github.com/advisories/GHSA-rmvr-2pp2-xj38) |
| `@octokit/request-error@3.0.3` | Regular-expression denial of service in error handling. | Fixed in `5.1.1`; crosses the installed major version. [Advisory](https://github.com/advisories/GHSA-xx4v-prfh-6cgc) |

The local backend has no configured Azure or GitHub integration. This limits the configured surface exercised by the demonstration, but is not a complete reachability analysis or justification for ignoring these dependencies in a company deployment.

## Applied remediation

`urllib@4.9.0` was replaced with **4.9.1** through a scoped override under `infinispan`. The patched version satisfies the parent's existing `^4.9.0` dependency range. It fixes credential-bearing headers being forwarded across origins during redirects. The installed lockfile confirms 4.9.1, and the finding disappeared from the full audit, reducing the total from 36 to 35. [Advisory](https://github.com/advisories/GHSA-hq3h-g68c-hp78)

## Remaining work

- Prefer compatible upstream Backstage and Azure dependency updates. A forced MSAL major override or changes to the Octokit dependency graph need targeted integration tests. Pinning `@azure/identity@4.13.0` would select the older, unaffected MSAL 3.x line within Backstage's declared range, but remains an unimplemented downgrade requiring compatibility review.
- The lab-only backend tree also includes findings in GraphQL Tools utilities, `basic-ftp`, `node-forge`, and `uuid`. Their parent chains include `mockttp`, Backstage backend defaults, and cloud storage clients. Several available fixes cross major versions.
- `node-forge@1.4.0` was the latest published version at review time, and its RSA signature-verification advisory listed **no patched version**. Track an upstream fix or a supported dependency replacement. [Advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
- Do **not** run `npm audit fix --force` to clear this report. Its proposed changes include historical Backstage downgrades such as `@backstage/plugin-scaffolder-node@0.1.5` and `@backstage/plugin-catalog-backend@1.26.1`; these are not compatible upgrades for this module.
- Before company installation, repeat both audits against the actual host application, choose a supported Backstage release and dependency resolution, and run the plugin's build, tests, and local integration suite. Keep the local demo service credential and permissive demo settings out of company configuration.

Audit counts and registry versions can change. Refresh this snapshot when updating the lockfile.
