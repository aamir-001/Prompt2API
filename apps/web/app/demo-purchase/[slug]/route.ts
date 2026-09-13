import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  boundedInteger,
  DemoPurchaseLimiter,
  parseDemoPurchaseInput,
  runConsumerAgentPurchase,
} from "../../../lib/demo-purchase";
import { OPERATOR_COOKIE, operatorSessionValue, safeEqual } from "../../../lib/operator-auth";

export const runtime = "nodejs";

const limiter = new DemoPurchaseLimiter(
  boundedInteger(process.env.DEMO_PURCHASE_COOLDOWN_MS, 10_000, 1_000, 60_000),
  boundedInteger(process.env.DEMO_PURCHASE_MAX_PER_PROCESS, 25, 1, 100),
);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  if (!demoPurchaseAllowed(request)) {
    return Response.json(
      { error: { code: "DEMO_PURCHASE_FORBIDDEN", message: "Demo purchasing is not available" } },
      { status: 403 },
    );
  }
  if (!isSameOrigin(request)) {
    return Response.json(
      { error: { code: "INVALID_ORIGIN", message: "Purchase requests must come from this site" } },
      { status: 403 },
    );
  }
  if (Number(request.headers.get("content-length") ?? 0) > 1_024) {
    return Response.json({ error: { code: "INVALID_PURCHASE_REQUEST" } }, { status: 400 });
  }

  let input;
  try {
    const { slug } = await context.params;
    input = parseDemoPurchaseInput(slug, await request.json().catch(() => null));
  } catch (error) {
    return Response.json(
      {
        error: {
          code: "INVALID_PURCHASE_REQUEST",
          message: error instanceof Error ? error.message : "Invalid purchase request",
        },
      },
      { status: 400 },
    );
  }

  const sessionId = request.cookies.get("prompt2api_demo_payer")?.value ?? randomUUID();
  const reservation = limiter.reserve(`${sessionId}:${input.slug}:${input.resource}`);
  if (!reservation.allowed) {
    return Response.json(
      {
        error: {
          code: reservation.reason === "limit" ? "DEMO_PURCHASE_LIMIT_REACHED" : "DEMO_PURCHASE_COOLDOWN",
          message: reservation.reason === "limit"
            ? "The demo payer has reached its process-level purchase limit"
            : `Wait ${reservation.retryAfterSeconds ?? 1} seconds before purchasing again`,
        },
      },
      reservation.retryAfterSeconds === undefined
        ? { status: 429 }
        : { status: 429, headers: { "retry-after": String(reservation.retryAfterSeconds) } },
    );
  }

  try {
    const result = await runConsumerAgentPurchase(input, {
      timeoutMs: boundedInteger(process.env.DEMO_PURCHASE_TIMEOUT_MS, 60_000, 10_000, 120_000),
    });
    return Response.json(result, {
      headers: {
        "cache-control": "no-store",
        "set-cookie": `prompt2api_demo_payer=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
      },
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "DEMO_PURCHASE_FAILED",
          message: "The restricted payer subprocess could not complete the x402 purchase",
        },
      },
      { status: 502 },
    );
  }
}

function demoPurchaseAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      if (isLoopbackHost(new URL(origin).hostname)) return true;
    } catch {
      return false;
    }
  }
  if (process.env.DEMO_PURCHASE_ENABLED !== "true") return false;
  const operatorToken = process.env.OPERATOR_API_TOKEN;
  return operatorToken !== undefined && safeEqual(
    request.cookies.get(OPERATOR_COOKIE)?.value,
    operatorSessionValue(operatorToken),
  );
}

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    const originUrl = new URL(origin);
    const targetHost = (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))
      ?.split(",")[0]
      ?.trim();
    const targetProtocol = (request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol)
      .split(",")[0]
      ?.trim();
    return targetHost !== undefined && originUrl.host === targetHost && originUrl.protocol === `${targetProtocol?.replace(/:$/, "")}:`;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
