import { createHash, timingSafeEqual } from "node:crypto";

export const OPERATOR_COOKIE = "indexloom_operator_session";

export function operatorSessionValue(token: string): string {
  return createHash("sha256").update("indexloom-operator-session\0").update(token).digest("base64url");
}

export function safeEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
