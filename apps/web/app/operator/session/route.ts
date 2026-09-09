import type { NextRequest } from "next/server";
import { OPERATOR_COOKIE, operatorSessionValue, safeEqual } from "../../../lib/operator-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  const expected = process.env.OPERATOR_API_TOKEN;
  if (!expected) {
    return Response.json({ status: "loopback_development" });
  }

  if (Number(request.headers.get("content-length") ?? 0) > 1_024) {
    return Response.json({ error: { code: "INVALID_OPERATOR_TOKEN" } }, { status: 401 });
  }
  const input = await request.json().catch(() => null) as { token?: unknown } | null;
  if (
    typeof input?.token !== "string" ||
    input.token.length > 256 ||
    !safeEqual(input.token, expected)
  ) {
    return Response.json({ error: { code: "INVALID_OPERATOR_TOKEN" } }, { status: 401 });
  }

  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": `${OPERATOR_COOKIE}=${operatorSessionValue(expected)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    },
  });
}

export async function DELETE(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": `${OPERATOR_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    },
  });
}
