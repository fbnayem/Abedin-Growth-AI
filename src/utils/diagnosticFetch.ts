import { apiFetch } from "../lib/apiFetch";
/**
 * Diagnostic Fetch Wrapper
 * Logs detailed request/response diagnostics, HTTP status codes, error bodies,
 * payload summaries, and latency for endpoints to diagnose generation issues.
 */

export interface DiagnosticLogOptions {
  context?: string;
  silentOnSuccess?: boolean;
}

export async function diagnosticFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: DiagnosticLogOptions
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method || "GET";
  const context = options?.context || "App";
  const startTime = performance.now();
  const timestamp = new Date().toISOString();

  let parsedRequestBody: any = null;
  if (init?.body && typeof init.body === "string") {
    try {
      parsedRequestBody = JSON.parse(init.body);
    } catch {
      parsedRequestBody = init.body;
    }
  }

  console.groupCollapsed(
    `%c[DIAGNOSTIC API REQUEST] %c${method} ${url} %c(${context})`,
    "color: #6366f1; font-weight: bold;",
    "color: #0ea5e9; font-weight: 600;",
    "color: #94a3b8; font-size: 11px;"
  );
  console.log("Timestamp:", timestamp);
  console.log("Endpoint:", url);
  console.log("Method:", method);
  console.log("Headers:", init?.headers);
  console.log("Request Payload:", parsedRequestBody ?? "(none)");
  console.groupEnd();

  try {
    const res = await apiFetch(input, init);
    const durationMs = Math.round(performance.now() - startTime);

    // Clone response stream so we can inspect status and body without consuming caller's stream
    const clone = res.clone();
    let responseBodyText = "";
    let parsedResponseBody: any = null;

    try {
      responseBodyText = await clone.text();
      try {
        parsedResponseBody = JSON.parse(responseBodyText);
      } catch {
        parsedResponseBody = responseBodyText;
      }
    } catch (readErr) {
      console.warn(`[DIAGNOSTIC] Could not read response body stream for ${url}:`, readErr);
    }

    if (!res.ok) {
      console.group(
        `%c🚨 [DIAGNOSTIC API ERROR] %c${method} ${url} %c→ Status: ${res.status} ${res.statusText} (${durationMs}ms)`,
        "color: #ef4444; font-weight: bold;",
        "color: #f87171; font-weight: 600;",
        "color: #fca5a5; font-size: 11px;"
      );
      console.error("HTTP Status Code:", res.status, res.statusText);
      console.error("Context / Caller:", context);
      console.error("Raw Error Body:", responseBodyText);
      console.error("Parsed Error Object:", parsedResponseBody);
      console.error("Original Request Payload:", parsedRequestBody);
      console.error("Response Headers:", Object.fromEntries(res.headers.entries()));
      console.groupEnd();
    } else {
      const isArray = Array.isArray(parsedResponseBody);
      const itemCount = isArray ? parsedResponseBody.length : null;

      if (isArray && itemCount === 0) {
        console.group(
          `%c⚠️ [DIAGNOSTIC WARNING] %c${method} ${url} %c→ Returned 200 OK but 0 items [] (${durationMs}ms)`,
          "color: #f59e0b; font-weight: bold;",
          "color: #fbbf24; font-weight: 600;",
          "color: #fde68a; font-size: 11px;"
        );
        console.warn("Request Payload:", parsedRequestBody);
        console.warn("Response Body:", parsedResponseBody);
        console.groupEnd();
      } else {
        console.groupCollapsed(
          `%c✅ [DIAGNOSTIC API SUCCESS] %c${method} ${url} %c→ Status: ${res.status} (${durationMs}ms${
            itemCount !== null ? `, ${itemCount} items` : ""
          })`,
          "color: #10b981; font-weight: bold;",
          "color: #34d399; font-weight: 600;",
          "color: #a7f3d0; font-size: 11px;"
        );
        console.log("HTTP Status Code:", res.status);
        console.log("Received Items Count:", itemCount !== null ? itemCount : "(not an array)");
        console.log("Response Body Preview:", parsedResponseBody);
        console.groupEnd();
      }
    }

    return res;
  } catch (networkError: any) {
    const durationMs = Math.round(performance.now() - startTime);
    console.group(
      `%c💥 [DIAGNOSTIC NETWORK EXCEPTION] %c${method} ${url} %c(${durationMs}ms)`,
      "color: #dc2626; font-weight: bold;",
      "color: #f87171; font-weight: 600;",
      "color: #fca5a5; font-size: 11px;"
    );
    console.error("Network / Fetch Error Message:", networkError?.message || networkError);
    console.error("Context / Caller:", context);
    console.error("Request Payload:", parsedRequestBody);
    console.error("Full Error Stack:", networkError?.stack);
    console.groupEnd();
    throw networkError;
  }
}
