# Apache Jena Fuseki sidecar (optional `fuseki` reasoner backend)

The BFF reasoner adapter (`bff/src/reasoner/`) has two interchangeable backends
behind the `REASONER_BACKEND` config toggle:

| Backend     | What it is                         | Ops cost            |
| ----------- | ---------------------------------- | ------------------- |
| `oxigraph`  | in-process WASM triplestore (default) | none — ships in the BFF |
| `fuseki`    | external Apache Jena Fuseki sidecar   | one JVM container   |

The default is `oxigraph`, so **nothing here is required for the demo**. This
sidecar is only for environments that want a standalone Jena triplestore.

## Enabling the Fuseki backend

```bash
# pick the backend (env override wins over admin-config.json)
export REASONER_BACKEND=fuseki
# point at the endpoint (default shown)
export FUSEKI_URL=http://localhost:3030/rtg
# OPTIONAL: HTTP Basic credentials. Real Fuseki deployments protect the update +
# Graph-Store (data-load) endpoints, so set these when the dataset isn't open.
# (Absent → no Authorization header, for an open/dev dataset.)
export FUSEKI_USER=admin
export FUSEKI_PASSWORD=changeme
```

> Verified live (2026-06-29) against `stain/jena-fuseki` with Basic auth:
> `REASONER_BACKEND=fuseki` builds the canonical store (load + candidate-signal
> entailment) and returns the **same** trust-critical answers as the default
> oxigraph backend — candidate-signal entails, the 3-edge mechanistic hero chain
> is SPARQL-confirmed, and deductive/statistical gating matches. (SHACL on Fuseki
> is the portable `minCount` check, not the full engine — see below.)

If `REASONER_BACKEND=fuseki` and no sidecar is reachable at `FUSEKI_URL`, the
adapter throws a clear `fuseki backend unavailable (no sidecar running …)` error
(with a short timeout) instead of hanging.

## docker-compose service stub (commented — do NOT merge into the Neo4j compose)

> [!IMPORTANT]
> Do NOT paste this into the existing `db:up` / Neo4j compose file. The current
> startup is Neo4j-only by design. This is a STANDALONE, opt-in stub: run it with
> its own compose file (e.g. `docker compose -f infra/fuseki/compose.yml up`)
> only when you actually want the `fuseki` backend.

```yaml
# infra/fuseki/compose.yml  (opt-in; standalone — keep separate from db:up)
# services:
#   fuseki:
#     image: apache/jena-fuseki:5.2.0          # or stain/jena-fuseki for older setups
#     container_name: rtg-fuseki
#     ports:
#       - "3030:3030"                          # matches FUSEKI_URL default host:port
#     environment:
#       - ADMIN_PASSWORD=changeme              # dev only; never commit a real secret
#       # Create an in-memory dataset named /rtg on startup so FUSEKI_URL works:
#       - FUSEKI_DATASET_1=rtg
#     # For persistence, mount a volume and use a TDB2 dataset instead of in-memory:
#     # volumes:
#     #   - rtg-fuseki-data:/fuseki
#
# volumes:
#   rtg-fuseki-data:
```

## What the adapter talks to (SPARQL 1.1 Protocol)

- `POST {FUSEKI_URL}` — SPARQL `query` (SELECT / ASK), `application/sparql-query`
- `POST {FUSEKI_URL}/update` — SPARQL `update` (entailment INSERT…WHERE),
  `application/sparql-update`
- `POST {FUSEKI_URL}/data?default` — Graph Store Protocol load of Turtle data

`validateShacl` on the `fuseki` backend uses a portable SPARQL-based check
(detects `sh:minCount`-1 property constraints via `FILTER NOT EXISTS`), since a
vanilla Fuseki exposes no standard SHACL HTTP endpoint. The full SHACL engine
runs on the `oxigraph` backend.
