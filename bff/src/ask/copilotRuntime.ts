/**
 * Copilot Runtime mount (Phase 2 slice 2a).
 *
 * Adopts the full CopilotKit v2 **Runtime** as the chat transport WITHOUT
 * weakening grounding. The Runtime is a transparent AG-UI proxy: the web client
 * talks to `/api/copilotkit` (runtimeUrl), and the Runtime forwards each run to a
 * single registered agent — an `HttpAgent` pointed at our UNTOUCHED grounded
 * bridge `POST /api/agui` → `askGraph` → Neo4j MCP (read-only). There is:
 *   - NO serviceAdapter, NO model, NO LLM API key on the Runtime (the v2 runtime
 *     takes AG-UI agents directly; it never calls a model itself).
 *   - NO second answer path. The only egress for answers is Runtime → /api/agui.
 * Grounding (citations, the read-only Cypher "show-your-work" trace, the
 * grounded-only `render_evidence` diagram, and the `NOT_IN_GRAPH:` refusal that
 * draws nothing) is produced entirely by the bridge and rides through the
 * Runtime untouched.
 *
 * Integration shape: `createCopilotEndpoint` returns a **Hono** app exposing a
 * web-standard `app.fetch(Request) => Promise<Response>`. Our server is Fastify
 * v5 (Node), so we adapt with one wildcard Fastify route that:
 *   1. reconstructs a web `Request` from the incoming Fastify request (method,
 *      url incl. the `/api/copilotkit` basePath the Hono app routes on, headers,
 *      and the raw body for POSTs), then
 *   2. calls `app.fetch(request)` and streams the web `Response` back out the raw
 *      socket (the run route returns a `text/event-stream`, so we must pipe the
 *      body, not buffer it).
 *
 * Routes exposed (Hono, under basePath): `GET /api/copilotkit/info`,
 * `POST /api/copilotkit/agent/:agentId/run`, `.../connect`, `.../stop/:threadId`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CopilotRuntime, createCopilotEndpoint } from "@copilotkit/runtime/v2";
import { HttpAgent } from "@ag-ui/client";
import { config } from "../config.js";

/** The basePath the Hono endpoint routes on. The web provider points its
 *  `runtimeUrl` here; Vite proxies `/api` → the BFF in dev. */
export const COPILOT_RUNTIME_BASE_PATH = "/api/copilotkit";

/**
 * Build the Runtime + Hono endpoint. The `default` agent is an `HttpAgent`
 * aimed at THIS server's own `/api/agui` bridge — a self-loopback so the
 * Runtime delegates to the untouched grounded path. The agent id MUST be
 * `default` to match the web `CopilotChat` binding.
 *
 * T7: a SECOND named agent, `generative`, points at the SAME bridge with
 * `?compose=generative` appended — the bridge reads that query param (same
 * Fastify handler, same RunAgentInput) and switches the grounded compose hook
 * from the classic dashboard lane to the Generative Studio tile lane. No new
 * route, no new LLM key, no weakening of grounding: still a self-loopback to
 * the one untouched `/api/agui` bridge.
 */
function buildCopilotEndpoint() {
  // Self-loopback to the grounded bridge on this same process/port.
  const aguiUrl = `http://127.0.0.1:${config.port}/api/agui`;
  const runtime = new CopilotRuntime({
    // NO serviceAdapter, NO model, NO key — the v2 runtime takes AG-UI agents
    // directly and proxies their events. The grounded answer comes from the
    // bridge the HttpAgent points at, never from a model on the Runtime.
    agents: {
      default: new HttpAgent({ url: aguiUrl }),
      generative: new HttpAgent({ url: `${aguiUrl}?compose=generative` }),
      // A THIRD agent for the orchestrated board lane (`?compose=board`): same
      // self-loopback bridge, but the query param routes to the planner → workers →
      // board-critic → reflexion composer (host-owned layout + filters + best-board).
      board: new HttpAgent({ url: `${aguiUrl}?compose=board` }),
    },
  });
  return createCopilotEndpoint({ runtime, basePath: COPILOT_RUNTIME_BASE_PATH });
}

/** Translate a Fastify request into a web-standard `Request` for `app.fetch`.
 *  The body is forwarded from the value captured by our raw content-type parser
 *  (a Buffer) so Fastify's default JSON parser never consumes/mutates it — the
 *  Runtime receives the exact bytes the client sent. */
function toWebRequest(req: FastifyRequest): Request {
  const method = req.method.toUpperCase();
  // Reconstruct the absolute URL the Hono app expects (it matches on the full
  // path including the basePath). Host header keeps it well-formed.
  const host = (req.headers.host as string) ?? `127.0.0.1:${config.port}`;
  const url = `http://${host}${req.raw.url ?? req.url}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, String(v));
  }

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const body = req.body;
    if (Buffer.isBuffer(body)) init.body = body;
    else if (typeof body === "string") init.body = body;
    else if (body != null) init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

/** Stream a web `Response` (possibly an SSE event-stream) out the Fastify raw
 *  socket. We pipe the body chunk-by-chunk so the run route's `text/event-stream`
 *  reaches the client incrementally rather than being buffered. */
async function sendWebResponse(reply: FastifyReply, res: Response): Promise<void> {
  reply.hijack(); // own the socket; Fastify won't also respond.
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  reply.raw.writeHead(res.status, headers);

  if (!res.body) {
    reply.raw.end();
    return;
  }
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) reply.raw.write(Buffer.from(value));
    }
  } finally {
    reply.raw.end();
  }
}

/**
 * Mount the Copilot Runtime on the given Fastify app under `/api/copilotkit/*`.
 *
 * Registered as an ENCAPSULATED Fastify plugin so its content-type parser is
 * scoped to this subtree only: a catch-all parser captures the request body as a
 * raw Buffer (instead of Fastify's default JSON parse) and hands it verbatim to
 * the Hono endpoint. This keeps the rest of the app (incl. the untouched
 * `/api/agui` bridge, which relies on parsed JSON) unaffected. One wildcard route
 * then forwards every method to the Hono endpoint's web-standard `fetch`.
 */
export async function registerCopilotRuntime(app: FastifyInstance): Promise<void> {
  const endpoint = buildCopilotEndpoint();

  await app.register(async (scope) => {
    // Capture ALL content types as a raw Buffer within this scope only.
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

    // Wildcard: GET /info, POST /agent/:id/run, /connect, /stop/:threadId all
    // land here and are routed by the Hono app on the full path (incl. basePath).
    scope.all(`${COPILOT_RUNTIME_BASE_PATH}/*`, async (req, reply) => {
      const webReq = toWebRequest(req);
      const webRes = await endpoint.fetch(webReq);
      await sendWebResponse(reply, webRes);
    });
  });
}
