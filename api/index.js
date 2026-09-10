// api/index.js
// Vercel Serverless Function: authenticates via API key, proxies a phone
// number lookup to an external backend, and returns pretty-printed JSON.
//
// Usage: GET /api?key=bunny&num=+919883444273  (also accepts spaces, or a bare number)

const { VALID_KEYS } = require("../config/keys");

const TARGET_HOST = "http://65.75.203.46:20094/api/number=";
const TIMEOUT_MS = 8000; // per spec — keep under Vercel's default 10s function timeout

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(data, null, 2));
}

// Strips +, +91, and any whitespace, leaving only digits.
function cleanNumber(raw) {
  if (!raw) return "";
  let n = String(raw).trim();
  n = n.replace(/\s+/g, ""); // remove all spaces
  n = n.replace(/^\+?91/, ""); // strip leading +91 or 91-with-plus
  n = n.replace(/^\+/, ""); // strip any remaining leading +
  n = n.replace(/\D/g, ""); // strip anything that isn't a digit, just in case
  return n;
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const { key, num } = req.query || {};

  if (!key || !VALID_KEYS.includes(key)) {
    return sendJson(res, 401, {
      status: false,
      message: "Invalid or missing API key.",
    });
  }

  if (!num) {
    return sendJson(res, 400, {
      success: false,
      error: "Missing required query parameter: num",
      example: "/api?key=bunny&num=9883444273",
    });
  }

  const cleaned = cleanNumber(num);

  if (!cleaned) {
    return sendJson(res, 400, {
      success: false,
      error: "Invalid 'num' parameter — no digits found after cleaning",
      received: num,
    });
  }

  const targetUrl = `${TARGET_HOST}${cleaned}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timeoutId);

    if (!upstreamRes.ok) {
      return sendJson(res, 502, {
        success: false,
        error: "Upstream API returned an error",
        status: upstreamRes.status,
        target: targetUrl,
      });
    }

    let data;
    try {
      data = await upstreamRes.json();
    } catch (parseErr) {
      return sendJson(res, 502, {
        success: false,
        error: "Upstream API returned non-JSON response",
        target: targetUrl,
      });
    }

    return sendJson(res, 200, {
      success: true,
      query: { num, cleaned },
      data,
    });
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === "AbortError") {
      return sendJson(res, 504, {
        success: false,
        error: `Upstream API timed out after ${TIMEOUT_MS}ms`,
        target: targetUrl,
      });
    }

    return sendJson(res, 502, {
      success: false,
      error: "Failed to reach upstream API",
      message: err.message,
      target: targetUrl,
    });
  }
};
