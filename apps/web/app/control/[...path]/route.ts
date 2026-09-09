import type { NextRequest } from "next/server";
import { OPERATOR_COOKIE, operatorSessionValue, safeEqual } from "../../../lib/operator-auth";

const apiUrl = (process.env.API_PUBLIC_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
export const runtime = "nodejs";

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  const target = new URL(`${apiUrl}/${path.map(encodeURIComponent).join("/")}`);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  const operatorToken = process.env.OPERATOR_API_TOKEN;
  if (operatorToken && path[0] === "v1" && path[1] === "pipelines") {
    const session = request.cookies.get(OPERATOR_COOKIE)?.value;
    if (!safeEqual(session, operatorSessionValue(operatorToken))) {
      return Response.json({ error: { code: "OPERATOR_AUTH_REQUIRED" } }, { status: 401 });
    }
    headers.set("authorization", `Bearer ${operatorToken}`);
  }

  const upstreamRequest: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    upstreamRequest.body = await request.arrayBuffer();
  }
  const upstream = await fetch(target, upstreamRequest);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}

export const GET = proxy;
export const POST = proxy;
