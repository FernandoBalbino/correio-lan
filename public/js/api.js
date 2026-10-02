export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}
export const session = {
  get: () => { try { return JSON.parse(sessionStorage.getItem('correio-lan:session') || 'null'); } catch { return null; } },
  set: value => sessionStorage.setItem('correio-lan:session', JSON.stringify(value)),
  clear: () => sessionStorage.removeItem('correio-lan:session'),
};
export async function api(path, { method = 'GET', body, signal, headers = {}, timeout = 15000, download = false } = {}) {
  const token = session.get()?.sessionToken;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Tempo de resposta excedido.')), timeout);
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const multipart = body instanceof FormData;
    const response = await fetch(`/api${path}`, {
      method, cache: 'no-store', signal: controller.signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(!multipart && body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    });
    if (download && response.ok) return response.blob();
    const result = await response.json();
    if (!response.ok || !result.success) {
      const error = new ApiError(result.error?.message || 'Não foi possível concluir a operação.', response.status, result.error?.code);
      if (response.status === 401) document.dispatchEvent(new CustomEvent('session-expired', { detail: error.message }));
      throw error;
    }
    return result.data;
  } catch (error) {
    if (error instanceof ApiError || signal?.aborted) throw error;
    throw new ApiError('Sem conexão com o servidor. Tente novamente; seu texto está preservado.', 0, 'NETWORK_ERROR');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
