// HTTP client for the MCSManager V10 panel API: authentication, rate limiting and secret redaction.

/** An error whose message is safe and useful to show to the model. */
export class McsmError extends Error {}

const STATUS_HINT = { 400: '（请求参数错误）', 403: '（权限不足或密钥无效）', 500: '（面板内部错误）' };
const RATE_WINDOW_MS = 60_000;
// Shorter strings would match ordinary text and turn the output into noise.
const MIN_SECRET_LENGTH = 4;

/**
 * @param {{ apiKey: string, panel: { origin: string, prefix: string, host: string, loopback: boolean },
 *           rateLimitPerMinute: number, timeoutMs: number }} settings
 */
export function createPanel({ apiKey, panel, rateLimitPerMinute, timeoutMs }) {
  const secrets = [panel.origin, apiKey, encodeURIComponent(apiKey), ...(panel.loopback ? [] : [panel.host])].filter(
    (secret) => secret.length >= MIN_SECRET_LENGTH,
  );

  /** Replaces the API key and the panel address wherever they appear. */
  function redact(text) {
    return secrets.reduce((out, secret) => out.replaceAll(secret, '<redacted>'), String(text));
  }

  const recentRequests = [];
  function takeRateLimitSlot() {
    const now = Date.now();
    while (recentRequests.length && now - recentRequests[0] > RATE_WINDOW_MS) recentRequests.shift();
    if (recentRequests.length >= rateLimitPerMinute) {
      throw new McsmError(`触发本地限流（每分钟最多 ${rateLimitPerMinute} 次请求），请稍后再试`);
    }
    recentRequests.push(now);
  }

  /** Calls a panel endpoint and returns the `data` field of its response envelope. */
  async function request(method, endpoint, { query = {}, body } = {}) {
    takeRateLimitSlot();
    const url = new URL(panel.origin + panel.prefix + endpoint);
    url.searchParams.set('apikey', apiKey);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'X-Requested-With': 'XMLHttpRequest', // required by the MCSM API
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', // never forward the key to a redirect target
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const reason = e.name === 'TimeoutError' ? '请求超时' : e.cause?.code || '网络错误或收到重定向（已拒绝跟随）';
      throw new McsmError(`无法连接面板: ${reason}`);
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new McsmError(`面板返回了非 JSON 内容 (HTTP ${response.status})，请检查 base_url 是否指向 MCSManager 面板`);
    }
    // MCSM reports errors with HTTP 200 and its own numeric status in the JSON body.
    if (Number(envelope?.status) !== 200) {
      const detail = typeof envelope?.data === 'string' ? envelope.data : JSON.stringify(envelope?.data ?? '');
      throw new McsmError(`面板返回 status=${envelope?.status}${STATUS_HINT[envelope?.status] ?? ''}: ${detail.slice(0, 300)}`);
    }
    return envelope.data;
  }

  return { request, redact };
}
