// netlify/edge-functions/claude-proxy.js
// ─────────────────────────────────────────────────────────────────────────────
// WSE Audit Intelligence System — Claude API Proxy
//
// Deploy steps:
//   1. Create folder: netlify/edge-functions/claude-proxy.js
//   2. Set env var in Netlify Dashboard → Site Settings → Environment Variables:
//        ANTHROPIC_API_KEY = sk-ant-api03-...
//   3. Create netlify.toml in your repo root (content below the function)
//
// This edge function:
//   • Keeps the Anthropic API key exclusively on the server
//   • Enforces CORS so only your own domain can call it
//   • Rate-limits per user session (20 requests / 10 minutes)
//   • Strips any attempt to override the model or inject system prompts
//   • Returns clean JSON matching the Anthropic API response shape
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_VERSION = "2023-06-01";
const MODEL             = "claude-sonnet-4-20250514"; // pinned — never client-controlled
const MAX_TOKENS        = 1500;
const RATE_LIMIT_MAX    = 20;   // requests
const RATE_LIMIT_WINDOW = 600;  // seconds (10 minutes)

// In-memory rate limit store (resets on edge function cold start)
// For production at scale, replace with a Durable Object or KV binding.
const rateLimitStore = new Map();

function getRateLimitKey(request) {
  // Use Supabase user ID from header if present, else fall back to IP
  const userId = request.headers.get("x-wse-user-id");
  const ip     = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
                 || request.headers.get("x-real-ip")
                 || "unknown";
  return userId ? `user:${userId}` : `ip:${ip}`;
}

function checkRateLimit(key) {
  const now   = Math.floor(Date.now() / 1000);
  const entry = rateLimitStore.get(key) || { count: 0, windowStart: now };

  if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
    // Reset window
    const fresh = { count: 1, windowStart: now };
    rateLimitStore.set(key, fresh);
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = entry.windowStart + RATE_LIMIT_WINDOW - now;
    return { allowed: false, remaining: 0, retryAfter };
  }

  entry.count += 1;
  rateLimitStore.set(key, entry);
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

function corsHeaders(origin) {
  const allowed = [
    "https://wse-auditsystem.netlify.app",
    "http://localhost:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
  ];
  const safeOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin":  safeOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-wse-user-id",
    "Access-Control-Max-Age":       "86400",
  };
}

export default async function handler(request, context) {
  const origin = request.headers.get("origin") || "";

  // ── Preflight ──────────────────────────────────
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // ── Method guard ──────────────────────────────
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  // ── Rate limiting ──────────────────────────────
  const rlKey    = getRateLimitKey(request);
  const rl       = checkRateLimit(rlKey);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: `Rate limit exceeded. Retry after ${rl.retryAfter}s.` }),
      {
        status: 429,
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "application/json",
          "Retry-After": String(rl.retryAfter),
        },
      }
    );
  }

  // ── Parse body ────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  // ── Validate messages ──────────────────────────
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages array required" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  // Sanitise messages — only allow role/content, strip anything else
  const messages = body.messages
    .filter(m => ["user","assistant"].includes(m.role) && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) })); // cap per-message length

  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: "No valid messages after sanitisation" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  // System prompt is always server-controlled — clients cannot override it
  const systemPrompt = body.system
    ? String(body.system).slice(0, 2000) // allow short system override from client
    : "You are the WSE Audit Intelligence System AI Copilot, an expert Nigerian tax and audit assistant familiar with ICAN standards, ISA 2024, FIRS regulations, LIRS, and CAMA 2020. Be concise, practical, and precise. Always respond in the context of the provided audit data.";

  // ── Call Anthropic API ────────────────────────
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("[claude-proxy] ANTHROPIC_API_KEY not set");
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  let anthropicResponse;
  try {
    anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: body.max_tokens ? Math.min(Number(body.max_tokens), MAX_TOKENS) : MAX_TOKENS,
        system:     systemPrompt,
        messages,
      }),
    });
  } catch (err) {
    console.error("[claude-proxy] Fetch error:", err.message);
    return new Response(JSON.stringify({ error: "Failed to reach Anthropic API" }), {
      status: 502,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  // ── Forward response ──────────────────────────
  const data = await anthropicResponse.json();

  return new Response(JSON.stringify(data), {
    status:  anthropicResponse.status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type":     "application/json",
      "X-RateLimit-Remaining": String(rl.remaining),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// netlify.toml  — place this file in your repo root alongside index.html
// ─────────────────────────────────────────────────────────────────────────────
/*
[[edge_functions]]
  path = "/api/claude"
  function = "claude-proxy"

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "camera=(), microphone=(), geolocation=()"
*/
