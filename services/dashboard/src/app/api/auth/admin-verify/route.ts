import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  ADMIN_COOKIE_NAME,
  COOKIE_MAX_AGE,
  isSecureRequest,
  signCookieValue,
  verifyCookieValue,
} from "@/lib/admin-session";

export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();

    if (!token) {
      return NextResponse.json(
        { error: "Admin token is required" },
        { status: 400 }
      );
    }

    const VEXA_ADMIN_API_KEY = process.env.VEXA_ADMIN_API_KEY || "";

    if (!VEXA_ADMIN_API_KEY) {
      return NextResponse.json(
        { error: "Admin API not configured" },
        { status: 500 }
      );
    }

    // Verify the token matches the configured admin key
    if (token !== VEXA_ADMIN_API_KEY) {
      return NextResponse.json(
        { error: "Invalid admin token" },
        { status: 401 }
      );
    }

    // Token is valid - set a secure session cookie
    const cookieStore = await cookies();

    // Create HMAC-signed session value
    const payload = Buffer.from(
      JSON.stringify({
        authenticated: true,
        timestamp: Date.now(),
      })
    ).toString("base64");

    const sessionValue = signCookieValue(payload);

    cookieStore.set(ADMIN_COOKIE_NAME, sessionValue, {
      httpOnly: true,
      secure: isSecureRequest(),
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });

    return NextResponse.json({
      success: true,
      message: "Admin authentication successful",
    });
  } catch (error) {
    console.error("Admin verify error:", error);
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 500 }
    );
  }
}

// Check if admin session is valid
export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(ADMIN_COOKIE_NAME);

    if (!sessionCookie) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    try {
      // Verify HMAC signature before trusting the payload
      const payload = verifyCookieValue(sessionCookie.value);
      if (!payload) {
        return NextResponse.json({ authenticated: false, reason: "invalid" }, { status: 401 });
      }

      const sessionData = JSON.parse(
        Buffer.from(payload, "base64").toString()
      );

      // Check if session is expired (24 hours)
      const sessionAge = Date.now() - sessionData.timestamp;
      if (sessionAge > COOKIE_MAX_AGE * 1000) {
        return NextResponse.json({ authenticated: false, reason: "expired" }, { status: 401 });
      }

      return NextResponse.json({ authenticated: true });
    } catch {
      return NextResponse.json({ authenticated: false, reason: "invalid" }, { status: 401 });
    }
  } catch (error) {
    console.error("Admin session check error:", error);
    return NextResponse.json({ authenticated: false }, { status: 500 });
  }
}
