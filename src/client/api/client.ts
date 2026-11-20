export type ApiEnvelope<T> = {
  ok: boolean
  schema_version: number
  as_of_seq: number
  data?: T
  error?: { code: string; message: string; retryable: boolean; details?: unknown }
}

export class ApiError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details: unknown

  constructor(code: string, message: string, retryable: boolean, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

export type ApiResult<T> = { data: T; as_of_seq: number }
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function unwrap<T>(res: Response): Promise<ApiResult<T>> {
  let body: ApiEnvelope<T>
  try { body = await res.json() as ApiEnvelope<T> } catch {
    throw new ApiError('SERVICE_UNAVAILABLE', '服务返回内容无法读取', true, { status: res.status })
  }
  if (body.schema_version !== 1) {
    throw new ApiError('PROTOCOL_VERSION_MISMATCH', '服务与面板协议版本不一致', false, { schema_version: body.schema_version })
  }
  if (!body.ok) {
    throw new ApiError(
      body.error?.code ?? 'SERVICE_UNAVAILABLE',
      body.error?.message ?? '服务没回应',
      body.error?.retryable ?? true,
      body.error?.details,
    )
  }
  if (typeof body.as_of_seq !== 'number' || !Number.isSafeInteger(body.as_of_seq) || body.as_of_seq < 0) {
    throw new ApiError('PROTOCOL_VERSION_MISMATCH', '服务返回的事件位置无效', false)
  }
  return { data: body.data as T, as_of_seq: body.as_of_seq }
}

export type ApiClient = {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<ApiResult<T>>
  post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<ApiResult<T>>
}

export function createApiClient(baseUrl: string, fetcher: FetchLike = globalThis.fetch.bind(globalThis)): ApiClient {
  const urlFor = (path: string, query?: Record<string, string | number | undefined>): string => {
    const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : baseUrl + '/')
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }
  const send = async <T>(path: string, init: RequestInit, query?: Record<string, string | number | undefined>): Promise<ApiResult<T>> => {
    init.signal?.throwIfAborted()
    let response: Response
    try { response = await fetcher(urlFor(path, query), init) } catch (error) {
      init.signal?.throwIfAborted()
      const timedOut = error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
      const commandOutcomeUnknown = init.method === 'POST'
      const code = timedOut ? 'OPERATION_TIMEOUT' : commandOutcomeUnknown ? 'OPERATION_OUTCOME_UNKNOWN' : 'SERVICE_UNAVAILABLE'
      const message = timedOut || commandOutcomeUnknown ? '请求结果暂不可确认' : '服务未连接'
      throw new ApiError(code, message, true)
    }
    const result = await unwrap<T>(response)
    init.signal?.throwIfAborted()
    return result
  }
  return {
    get: <T>(path: string, query?: Record<string, string | number | undefined>) => send<T>(path, { method: 'GET', headers: { accept: 'application/json' } }, query),
    post: <T>(path: string, payload: unknown, signal?: AbortSignal) => send<T>(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    }),
  }
}
