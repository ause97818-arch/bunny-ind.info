// api/index.js
// Vercel Serverless Function: authenticates via API key, proxies a phone
// number lookup to an external backend (with retries), and returns
// pretty-printed JSON.
//
// Usage: GET /api?key=bunny&num=+919883444273  (also accepts spaces, or a bare number)

const { VALID_KEYS } = require("../config/keys");

const TARGET_HOST = "http://65.75.203.46:20094/api/number=";
const TIMEOUT_MS = 25000; // per-attempt timeout
const MAX_RETRIES = 2; // retries AFTER the first attempt (3 attempts total)
const RETRY_DELAY_MS = 500; // small pause between attempts

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetches targetUrl with a per-attempt timeout, retrying up to MAX_RETRIES
// times on timeout, network error, or a non-2xx status. Logs each attempt.
async function fetchWithRetry(targetUrl) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      console.log(`[proxy] attempt ${attempt}/${MAX_RETRIES + 1} -> ${targetUrl}`);

      const upstreamRes = await fetch(targetUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });

      clearTimeout(timeoutId);

      if (!upstreamRes.ok) {
        lastError = {
          type: "http_error",
          status: upstreamRes.status,
        };
        console.log(`[proxy] attempt ${attempt} failed: HTTP ${upstreamRes.status}`);
      } else {
        return { ok: true, res: upstreamRes };
      }
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err.name === "AbortError";
      lastError = {
        type: isTimeout ? "timeout" : "network_error",
        message: err.message,
      };
      console.log(
        `[proxy] attempt ${attempt} ${isTimeout ? "timed out" : "errored"}: ${err.message}`
      );
    }

    // If this wasn't the last attempt, wait briefly then retry.
    if (attempt <= MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  return { ok: false, error: lastError };
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

  const result = await fetchWithRetry(targetUrl);

  if (!result.ok) {
    const err = result.error || {};
    if (err.type === "timeout") {
      return sendJson(res, 504, {
        success: false,
        error: `Upstream API timed out after ${MAX_RETRIES + 1} attempts (${TIMEOUT_MS}ms each)`,
        target: targetUrl,
      });
    }
    return sendJson(res, 502, {
      success: false,
      error: `Upstream API failed after ${MAX_RETRIES + 1} attempts`,
      detail: err,
      target: targetUrl,
    });
  }

  let data;
  try {
    data = await result.res.json();
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
};
