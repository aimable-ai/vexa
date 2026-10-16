import crypto from "crypto";

export const ADMIN_COOKIE_NAME = "vexa-admin-session";
export const COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours

function getSigningSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return secret;
}

export function isSecureRequest(): boolean {
  return process.env.NEXTAUTH_URL?.startsWith("https://") ||
         process.env.DASHBOARD_URL?.startsWith("https://") ||
         false;
}

export function signCookieValue(payload: string): string {
  const hmac = crypto.createHmac("sha256", getSigningSecret()).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

export function verifyCookieValue(signed: string): string | null {
  const dotIndex = signed.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const payload = signed.substring(0, dotIndex);
  const signature = signed.substring(dotIndex + 1);
  const expected = crypto.createHmac("sha256", getSigningSecret()).update(payload).digest("hex");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so guard it first.
  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }
  return payload;
}

/**
 * Validate an admin session cookie value.
 * SECURITY: verifies the HMAC signature (constant-time) BEFORE trusting the
 * payload, then checks that the session is authenticated and not expired.
 * Returns false on a missing, forged, malformed or expired cookie.
 */
export function isValidAdminSession(cookieValue: string | undefined | null): boolean {
  if (!cookieValue) {
    return false;
  }

  try {
    // Reject anything whose signature does not match before decoding the payload.
    const payload = verifyCookieValue(cookieValue);
    if (!payload) {
      return false;
    }

    const sessionData = JSON.parse(
      Buffer.from(payload, "base64").toString()
    );

    // Check if session is expired (24 hours)
    const sessionAge = Date.now() - sessionData.timestamp;
    if (sessionAge > COOKIE_MAX_AGE * 1000) {
      return false;
    }

    return sessionData.authenticated === true;
  } catch {
    return false;
  }
}
