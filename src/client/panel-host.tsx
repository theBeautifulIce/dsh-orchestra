import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ApiError, createApiClient, type ApiClient, type FetchLike } from './api/client.ts'
import { createConnectedEventStream } from './api/event-stream.ts'
import type { StreamStatus } from './api/sse.ts'
import { PanelApp } from './panel/app.tsx'
import type { PanelRoute } from './panel/shell.tsx'
import { SettingsScreen } from './panel/settings-screen.tsx'

export type PanelHostProps = {
  /** 服务地址，例如 http://127.0.0.1:8787 */
  baseUrl: string
  /** 宿主自己的 fetch（带鉴权头也行）；不给就用全局 fetch。 */
  fetcher?: FetchLike
  /** 宿主已经建好的 API 客户端；给了就不再新建。 */
  client?: ApiClient
  /** 事件流请求的附加参数（请求头等）。 */
  requestInit?: Omit<RequestInit, 'method' | 'signal'>
  /** 面板版本；宿主拿不到就传空，设置屏显示「未知」。 */
  panelVersion?: string
  /** 首屏路由；不给就是任务页。 */
  initialRoute?: PanelRoute
}

export type PanelHostStatus = {
  serviceConnected?: boolean
  protocolMismatch?: boolean
  phase?: string
  streamStatus?: StreamStatus
}

/** 宿主正式入口：把 API 客户端、事件流与面板组装起来，外部宿主一行接入。 */
export function createPanelHost(options: PanelHostProps): () => ReactElement {
  function BoundPanelHost(): ReactElement {
    return <PanelHost {...options} />
  }
  BoundPanelHost.displayName = 'PanelHost'
  return BoundPanelHost
}

export function PanelHost(props: PanelHostProps): ReactElement {
  const fetcher = useMemo<FetchLike>(
    () => props.fetcher ?? globalThis.fetch.bind(globalThis),
    [props.fetcher],
  )
  const client = useMemo<ApiClient>(
    () => props.client ?? createApiClient(props.baseUrl, fetcher),
    [props.client, props.baseUrl, fetcher],
  )
  const requestInitRef = useRef(props.requestInit)
  useEffect(() => {
    requestInitRef.current = props.requestInit
  }, [props.requestInit])

  const [status, setStatus] = useState<PanelHostStatus>({})

  // 真实状态只有一个来源：探测 /health。连不上的项一律留空，设置屏显示「未知」。
  const probe = useCallback(() => {
    let cancelled = false
    void client.get<{ ok?: boolean; phase?: string; epoch?: number }>('/health').then((result) => {
      if (cancelled) return
      setStatus((previous) => ({
        ...previous,
        serviceConnected: true,
        protocolMismatch: false,
        phase: typeof result.data.phase === 'string' ? result.data.phase : previous.phase,
      }))
    }).catch((error: unknown) => {
      if (cancelled) return
      const mismatch = error instanceof ApiError && error.code === 'PROTOCOL_VERSION_MISMATCH'
      setStatus((previous) => ({
        ...previous,
        serviceConnected: mismatch,
        protocolMismatch: mismatch,
      }))
    })
    return () => { cancelled = true }
  }, [client])

  useEffect(() => probe(), [probe])

  // 事件流回调是面板实时状态的唯一来源；身份必须稳定，否则面板会不停重建事件流。
  const createEventStream = useCallback(
    (onInvalidate: (type: string) => void, onStatus: (status: StreamStatus) => void) =>
      createConnectedEventStream({
        client,
        fetcher,
        baseUrl: props.baseUrl,
        requestInit: requestInitRef.current,
        onInvalidate,
        onStatus: (status) => {
          setStatus((previous) => ({ ...previous, streamStatus: status }))
          onStatus(status)
        },
      }),
    [client, fetcher, props.baseUrl],
  )

  const settingsScreen = useMemo(
    () => (
      <SettingsScreen
        serviceConnected={status.serviceConnected}
        protocolMismatch={status.protocolMismatch}
        snapshotStale={status.streamStatus === 'stale'}
        streamStatus={status.streamStatus}
        phase={status.phase}
        panelVersion={props.panelVersion}
        onRefresh={probe}
      />
    ),
    [status, props.panelVersion, probe],
  )

  return <PanelApp
    client={client}
    serviceConnected={status.serviceConnected ?? false}
    protocolMismatch={status.protocolMismatch ?? false}
    snapshotStale={status.streamStatus === 'stale'}
    initialRoute={props.initialRoute}
    createEventStream={createEventStream}
    additionalScreens={{ settings: settingsScreen }}
  />
}
