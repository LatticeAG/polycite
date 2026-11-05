# PolyCite

[![CI](https://github.com/LatticeAG/polycite/actions/workflows/ci.yml/badge.svg)](https://github.com/LatticeAG/polycite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org)
[![Protocol](https://img.shields.io/badge/protocol-pc--request--1-6f42c1.svg)](#wire-protocols)

Machine-checkable citation enforcement at the response boundary. PolyCite sits
between answer generation and delivery: every factual claim in a plain-text
draft is split into atomic statements, aligned against a signed retrieval
snapshot, and delivered only with verdicts (`supported` / `unsupported` /
`contradicted`), a signed audit chain, and an inline provenance ledger — or
visibly withheld.

## What "supported" means

`supported` means an approved primary-source snapshot directly asserts the
entire recognized statement under the pinned `pc-en-1` grammar. It does **not**
mean the assertion is objectively true, current outside the admitted snapshot,
or independently authenticated by the publisher. An Ed25519 retrieval signature
proves which configured retriever attested the bytes; an Ed25519 receipt proves
which verifier emitted the decision. PolyCite never advertises an unqualified
"fact checked" badge.

## Packages

| Package | Contents |
|---|---|
| [`@latticeag/polycite-core`](packages/core) | Strict codecs, RFC 8785 canonical JSON, SHA-256/Ed25519, `pc-split-1` splitter, `pc-en-1` grammar, source aligner, verdicts, pruning, ledger, signatures |
| [`@latticeag/polycite`](packages/sdk) | The six-operation SDK, local signer, PolyBrain `beforeSend` adapter, VisBoard render adapter |
| [`polycite`](packages/cli) | CLI: `keygen`, `seal`, `check`, `batch`, `inspect`, `render`, `config check` |
| [`@latticeag/polycite-worker`](packages/worker) | Authenticated HTTP wrapper around the identical core (bounded synchronous verification and batch) |

## Quick start

Run this from the repository root after cloning. It builds the packages and runs
an isolated local ceremony with two separate signing keys:

```bash
pnpm install && pnpm build
REPO="$PWD"
WORK="$(mktemp -d "$REPO/quickstart.XXXXXX")"
cd "$WORK"
mkdir private
PC="$REPO/packages/cli/dist/main.js"
CORE="$REPO/packages/core/dist/index.js"
export CORE
node "$PC" keygen --out private/retriever.key --public-out retriever.pub.json
node "$PC" keygen --out private/receipt.key --public-out receipt.pub.json
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const { hashHex, nowUtcTime } = await import(process.env.CORE);
const retriever = JSON.parse(readFileSync('retriever.pub.json'));
const receipt = JSON.parse(readFileSync('receipt.pub.json'));
const tenant_id = 'pct_LLLLLLLLLLLLLLLLLLLLL';
const text = 'Acme is a company.';
const contract = { version:'pc-contract-1', delivery:'block', rewrite:'off',
  max_age_s:900, future_skew_s:60, splitter:'pc-split-1', grammar:'pc-en-1',
  retrieval_keys:[{ ...retriever, authorities:['acme'] }] };
const config = { version:'pc-config-1', tenant_id, contract, receipt_keys:[receipt],
  local_signer:{ key_id:receipt.key_id, seed_file:'./private/receipt.key' }, hosted:null };
const body = { version:'pc-retrieval-1', audience:tenant_id, retrieved_at:nowUtcTime(),
  sources:[{ source_id:'pcs_AAAAAAAAAAAAAAAAAAAAA', kind:'text', authority:'acme',
    role:'primary', origin:'urn:acme:filing:2025', extraction:'standalone', text,
    content_hash:await hashHex(new TextEncoder().encode(text)) }] };
writeFileSync('polycite.json', JSON.stringify(config, null, 2));
writeFileSync('body.json', JSON.stringify(body, null, 2));
JS
node "$PC" config check
node "$PC" seal --input body.json --key private/retriever.key --out retrieval.json --quiet
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const { hashHex, J } = await import(process.env.CORE);
const config = JSON.parse(readFileSync('polycite.json'));
const request = { version:'pc-request-1', run_id:'pcr_RRRRRRRRRRRRRRRRRRRRR',
  contract_hash:await hashHex(J(config.contract)), format:'plain', language:'en',
  draft:'Acme is a company.', retrieval:JSON.parse(readFileSync('retrieval.json')) };
writeFileSync('request.json', JSON.stringify(request, null, 2));
JS
node "$PC" check --input request.json --json --out package.json
```

The generated `polycite.json` contains the contract, trusted public keys and
local receipt signer. The example snapshot expires after 900 seconds; refresh
its `retrieved_at`, seal it again, and update the request before checking later.

- `check` exits `0` (release), `10` (annotated) or `11` (blocked) and always
  emits the full signed audit package.
- `render` validates the package at delivery time and prints the canonical
  text, including the inline ledger.
- `inspect --at <time>` performs historical (non-delivery) verification.

## Wire protocols

`pc-request-1`, `pc-contract-1`, `pc-retrieval-1`, `pc-decision-1`,
`pc-entry-1`, `pc-result-1`, `pc-package-1`, `pc-batch-request-1`,
`pc-batch-result-1`, `pc-keys-1`, `pc-health-1`, `pc-config-1`,
`pc-worker-config-1`, `pc-op-1`, `pc-error-1`; profiles `pc-split-1`,
`pc-en-1`. Signing domains `PolyCite.retrieval.v1` and `PolyCite.entry.v1`
(LF + raw SHA-256 digest, RFC 8032 Ed25519). All JSON on the wire is
RFC 8785 canonical.

## Guarantees and limits

- Text-only: declared or detected tables/charts/markup are rejected.
- The grammar is deliberately narrow; unrecognized claims stay covered but
  `unsupported`. Default delivery is blocked unless every claim is supported.
- No model calls, no retrieval, no URL fetches: the verifier consumes a
  caller-supplied signed snapshot only.
- The hosted surface is bounded synchronous verification only — no hosted
  retention, job platform, or dashboards.

## Development

```console
pnpm test                # unit + integration tests
pnpm run test:conformance  # TV-P--01..68 vectors
pnpm run test:workers      # Worker-surface vectors
pnpm run test:interop      # Python interoperability suite
pnpm run typecheck && pnpm run lint
pnpm run bench:gate        # latency gate
```

## License

MIT — see [LICENSE](LICENSE). Hosted batch verification is a paid surface;
the MIT core never changes verdict semantics between local and hosted runs.
