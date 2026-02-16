import type { IncomingMessage, ServerResponse } from "node:http";
import { deriveDeviceIdFromPublicKey, verifyDeviceSignature } from "../infra/device-identity.js";
import {
  requestDevicePairing,
  getDevicePairingResolution,
  listDevicePairing,
  type DevicePairingPendingRequest,
} from "../infra/device-pairing.js";
import { resolveGatewayClientIp } from "./net.js";
import { safeEqual, type ResolvedGatewayAuth } from "./auth.js";
import type { PairRateLimiter } from "./pair-rate-limit.js";
import type { PairBanManager } from "./pair-ban.js";
import type { GatewayApprovalConfig } from "../config/types.gateway.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function send429(res: ServerResponse, retryAfterSeconds: number) {
  res.statusCode = 429;
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, error: "rate limit exceeded" }));
}

const MAX_PAIR_BODY_BYTES = 64 * 1024;

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = MAX_PAIR_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) {
        return;
      }
      done = true;
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve({ ok: true, value: parsed });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
    req.on("error", (err) => {
      if (done) {
        return;
      }
      done = true;
      resolve({ ok: false, error: String(err) });
    });
    req.on("close", () => {
      if (done) return;
      done = true;
      resolve({ ok: false, error: "connection closed" });
    });
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validatePassword(
  body: Record<string, unknown>,
  approvalConfig: GatewayApprovalConfig | undefined,
): boolean {
  const configuredPassword = approvalConfig?.password;
  if (!configuredPassword) return true; // no password configured = LAN-only mode, skip check
  const provided = typeof body.password === "string" ? body.password : "";
  return safeEqual(provided, configuredPassword);
}

export function createPairHttpHandler(opts: {
  resolvedAuth: ResolvedGatewayAuth;
  rateLimiter: PairRateLimiter;
  banManager: PairBanManager;
  trustedProxies?: string[];
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { resolvedAuth, rateLimiter, banManager, trustedProxies } = opts;

  return async (req, res) => {
    if (resolvedAuth.mode !== "approval") {
      return false;
    }

    const url = req.url ?? "/";
    if (!url.startsWith("/pair/")) {
      return false;
    }

    const subPath = url.slice("/pair/".length).split("?")[0];
    if (!subPath || (subPath !== "status" && subPath !== "request")) {
      return false;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    try {
      // 1. Resolve client IP
      const remoteIp = resolveGatewayClientIp({
        remoteAddr: req.socket?.remoteAddress ?? "",
        forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
        realIp: headerValue(req.headers?.["x-real-ip"]),
        trustedProxies,
      });

      if (!remoteIp) {
        sendJson(res, 400, { ok: false, error: "invalid request body" });
        return true;
      }

      // 2. Check ban
      if (banManager.isBanned(remoteIp)) {
        sendJson(res, 403, { ok: false, error: "forbidden" });
        return true;
      }

      if (subPath === "request") {
        return await handlePairRequest(req, res, remoteIp);
      }

      if (subPath === "status") {
        return await handlePairStatus(req, res, remoteIp);
      }

      sendJson(res, 404, { ok: false, error: "Not Found" });
      return true;
    } catch {
      sendJson(res, 500, { ok: false, error: "Internal Server Error" });
      return true;
    }
  };

  async function handlePairRequest(
    req: IncomingMessage,
    res: ServerResponse,
    remoteIp: string,
  ): Promise<boolean> {
    // 3. checkRequest rate limit
    const checkResult = rateLimiter.checkRequest(remoteIp);
    if (!checkResult.ok) {
      send429(res, checkResult.retryAfterSeconds);
      return true;
    }

    // 4. recordRequest IMMEDIATELY after check passes, before body read
    rateLimiter.recordRequest(remoteIp);

    // 5. Read body
    const bodyResult = await readJsonBody(req);
    if (!bodyResult.ok) {
      if (bodyResult.error === "payload too large") {
        sendJson(res, 413, { ok: false, error: "payload too large" });
      } else {
        sendJson(res, 400, { ok: false, error: "invalid request body" });
      }
      return true;
    }
    if (!bodyResult.value || typeof bodyResult.value !== "object" || Array.isArray(bodyResult.value)) {
      sendJson(res, 400, { ok: false, error: "invalid request body" });
      return true;
    }
    const body = bodyResult.value as Record<string, unknown>;

    // 6. Validate password
    if (!validatePassword(body, resolvedAuth.approval)) {
      banManager.recordFailure(remoteIp);
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }

    // 7. Validate required fields
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : undefined;
    const publicKey = typeof body.publicKey === "string" ? body.publicKey.trim() : undefined;
    const signature = typeof body.signature === "string" ? body.signature.trim() : undefined;
    const signedAt = typeof body.signedAt === "number" ? body.signedAt : undefined;

    if (!deviceId || !publicKey || !signature || !signedAt) {
      sendJson(res, 400, { ok: false, error: "required fields missing" });
      return true;
    }

    // 8. Validate device identity
    const derivedDeviceId = deriveDeviceIdFromPublicKey(publicKey);
    if (!derivedDeviceId || derivedDeviceId !== deviceId) {
      sendJson(res, 400, { ok: false, error: "invalid request body" });
      return true;
    }

    const payload = `${deviceId}:${signedAt}`;
    if (!verifyDeviceSignature(publicKey, payload, signature)) {
      sendJson(res, 400, { ok: false, error: "invalid request body" });
      return true;
    }

    // 9. Validate clock skew
    const now = Date.now();
    const clockSkewMs = Math.abs(now - signedAt);
    if (clockSkewMs > 60_000) {
      sendJson(res, 400, { ok: false, error: "invalid request body" });
      return true;
    }

    // 10. track pending count
    rateLimiter.track(remoteIp);

    // 11. Submit pairing request with server-assigned defaults (D10, D14)
    const client =
      typeof body.client === "object" && body.client !== null ? body.client : undefined;
    const pairingRequest: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair"> = {
      deviceId,
      publicKey,
      displayName:
        typeof (client as any)?.displayName === "string"
          ? (client as any).displayName
          : undefined,
      platform:
        typeof (client as any)?.platform === "string" ? (client as any).platform : undefined,
      role: "operator",
      scopes: ["operator.admin"],
      remoteIp,
      silent: false,
    };

    try {
      const result = await requestDevicePairing(pairingRequest);
      // 12. Return result
      sendJson(res, 200, { status: "pending", requestId: result.request.requestId });
      return true;
    } finally {
      rateLimiter.release(remoteIp);
    }
  }

  async function handlePairStatus(
    req: IncomingMessage,
    res: ServerResponse,
    remoteIp: string,
  ): Promise<boolean> {
    // 3. checkStatus rate limit
    const checkResult = rateLimiter.checkStatus(remoteIp);
    if (!checkResult.ok) {
      send429(res, checkResult.retryAfterSeconds);
      return true;
    }

    // 4. recordStatus IMMEDIATELY after check passes
    rateLimiter.recordStatus(remoteIp);

    // 5. Read body
    const bodyResult = await readJsonBody(req);
    if (!bodyResult.ok) {
      if (bodyResult.error === "payload too large") {
        sendJson(res, 413, { ok: false, error: "payload too large" });
      } else {
        sendJson(res, 400, { ok: false, error: "invalid request body" });
      }
      return true;
    }
    if (!bodyResult.value || typeof bodyResult.value !== "object" || Array.isArray(bodyResult.value)) {
      sendJson(res, 400, { ok: false, error: "invalid request body" });
      return true;
    }
    const body = bodyResult.value as Record<string, unknown>;

    // 6. Validate password
    if (!validatePassword(body, resolvedAuth.approval)) {
      banManager.recordFailure(remoteIp);
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }

    // 7. Validate required fields
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : undefined;
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : undefined;

    if (!requestId || !deviceId) {
      sendJson(res, 400, { ok: false, error: "required fields missing" });
      return true;
    }

    // 8. Check resolved store
    const resolved = await getDevicePairingResolution(requestId);
    if (resolved) {
      if (resolved.deviceId === deviceId) {
        if (resolved.decision === "approved") {
          sendJson(res, 200, { status: "approved" });
          return true;
        }
        if (resolved.decision === "rejected") {
          sendJson(res, 200, { status: "rejected" });
          return true;
        }
      }
      // deviceId mismatch
      sendJson(res, 200, { status: "unknown" });
      return true;
    }

    // 9. Check pending
    const { pending } = await listDevicePairing();
    const pendingRequest = pending.find(
      (p) => p.requestId === requestId && p.deviceId === deviceId,
    );

    if (pendingRequest) {
      sendJson(res, 200, { status: "pending", retryAfterMs: 3000 });
      return true;
    }

    // 10. Unknown
    sendJson(res, 200, { status: "unknown" });
    return true;
  }
}
