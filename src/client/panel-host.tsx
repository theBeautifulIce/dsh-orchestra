import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ApiError, createApiClient, type ApiClient, type FetchLike } from './api/client.ts'
import { createConnectedEventStream } from './api/event-stream.ts'
import type { StreamStatus } from './api/sse.ts'
import { PanelApp } from './panel/app.tsx'
import type { PanelRoute } from './panel/shell.tsx'

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
  memoryEnabled?: boolean
  memoryProposalOnly?: boolean
  modelRoutingEnabled?: boolean
  planningTimeoutsEnabled?: boolean
  modelEscalationEnabled?: boolean
  collaborationEnabled?: boolean
  reworkEnabled?: boolean
  reworkPlannerEnabled?: boolean
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
  const probeGeneration = useRef(0)

  // 真实状态只有一个来源：探测 /health。连不上的项一律留空，设置屏显示「未知」。
  const probe = useCallback(async (): Promise<boolean> => {
    const generation = ++probeGeneration.current
    try {
      const result = await client.get<{ ok?: boolean; phase?: string; epoch?: number; memory_enabled?: boolean; memory_proposal_only?: boolean; model_routing_enabled?: boolean; planning_timeouts_enabled?: boolean; model_escalation_enabled?: boolean; collaboration_enabled?: boolean; rework_enabled?: boolean; rework_planner_enabled?: boolean }>('/health')
      if (generation !== probeGeneration.current) return false
      setStatus((previous) => ({
        ...previous,
        serviceConnected: true,
        protocolMismatch: false,
        phase: typeof result.data.phase === 'string' ? result.data.phase : previous.phase,
        memoryEnabled: typeof result.data.memory_enabled === 'boolean' ? result.data.memory_enabled : undefined,
        memoryProposalOnly: result.data.memory_proposal_only === true,
        modelRoutingEnabled: result.data.model_routing_enabled === true,
        planningTimeoutsEnabled: result.data.planning_timeouts_enabled === true,
        modelEscalationEnabled: result.data.model_escalation_enabled === true,
        collaborationEnabled: result.data.collaboration_enabled === true,
        reworkEnabled: result.data.rework_enabled === true,
        reworkPlannerEnabled: result.data.rework_planner_enabled === true,
      }))
      return true
    } catch (error) {
      if (generation !== probeGeneration.current) return false
      const mismatch = error instanceof ApiError && error.code === 'PROTOCOL_VERSION_MISMATCH'
      setStatus((previous) => ({
        ...previous,
        serviceConnected: mismatch,
        protocolMismatch: mismatch,
      }))
      return false
    }
  }, [client])

  useEffect(() => {
    void probe()
    return () => { probeGeneration.current += 1 }
  }, [probe])

  // 事件流回调是面板实时状态的唯一来源；身份必须稳定，否则面板会不停重建事件流。
  const createEventStream = useCallback(
    (onInvalidate: (type: string) => void, onStatus: (status: StreamStatus) => void) =>
      createConnectedEventStream({
        client,
        fetcher,
        baseUrl: props.baseUrl,
        requestInit: requestInitRef.current,
        onInvalidate,
        onStatus,
      }),
    [client, fetcher, props.baseUrl],
  )

  return <PanelApp
    client={client}
    serviceConnected={status.serviceConnected ?? false}
    protocolMismatch={status.protocolMismatch ?? false}
    initialRoute={props.initialRoute}
    memoryEnabled={status.serviceConnected ? status.memoryEnabled : false}
    memoryProposalOnly={status.serviceConnected && status.memoryProposalOnly}
    modelRoutingEnabled={status.modelRoutingEnabled}
    planningTimeoutsEnabled={status.planningTimeoutsEnabled}
    collaborationEnabled={status.collaborationEnabled}
    reworkEnabled={status.reworkEnabled}
    modelEscalationEnabled={status.modelEscalationEnabled}
    reworkPlannerEnabled={status.reworkPlannerEnabled}
    createEventStream={createEventStream}
    servicePhase={status.phase}
    panelVersion={props.panelVersion}
    refreshServiceStatus={probe}
  />
}
