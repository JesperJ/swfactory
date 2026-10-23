// Two secrets:
//   FACTORY_HOOK_TOKEN  - bearer token the Claude Code hooks send. Can only report session events.
//   FACTORY_PASSWORD    - what you type once per device to open the dashboard.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

export const COOKIE = "factory_session";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// The cookie carries an HMAC of the password, so changing the password logs every device out.
function cookieValue(password: string): string {
  return createHmac("sha256", password).update("factory-ui-v1").digest("base64url");
}

export function isLoggedIn(c: Context, password: string): boolean {
  const v = getCookie(c, COOKIE);
  return !!v && safeEqual(v, cookieValue(password));
}

export function checkPassword(attempt: string, password: string): boolean {
  return safeEqual(cookieValue(attempt), cookieValue(password));
}

export function logIn(c: Context, password: string): void {
  const https = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
  setCookie(c, COOKIE, cookieValue(password), {
    httpOnly: true,
    secure: https,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export function logOut(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

export function requireUi(password: string): MiddlewareHandler {
  return async (c, next) => {
    if (isLoggedIn(c, password)) return next();
    if (c.req.path.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
    return c.redirect("/login");
  };
}

export function requireHookToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (given && safeEqual(given, token)) return next();
    return c.json({ error: "unauthorized" }, 401);
  };
}
