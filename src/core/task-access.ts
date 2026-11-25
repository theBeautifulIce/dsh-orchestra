/** Task-tool access is separate from the configured model transport and internal ledger.
 * No unclassified host plugin or fixed command is assumed to be offline or file-free.
 * The only known file-free external adapter is registered and verified by the host.
 */
export type TaskAccessContract = { constraints: readonly { kind: string }[] }

export function taskAccess(contract?: TaskAccessContract) {
  const kinds = new Set(contract?.constraints.map(item => item.kind) ?? [])
  return { noNetwork: kinds.has('no_network'), noWorkspaceRead: kinds.has('no_workspace_read'),
    noWorkspaceWrite: kinds.has('no_workspace_files'),
    restricted: kinds.has('no_network') || kinds.has('no_workspace_read'),
    noOpaqueCode: ['no_network', 'no_workspace_read', 'no_workspace_files', 'read_only', 'no_external_send', 'preserve_input'].some(kind => kinds.has(kind)) }
}

/** Call only for non-Orchestra tools; a trusted file-free adapter is an explicit provenance decision, not a name match. */
export function restrictedTaskToolReason(contract: TaskAccessContract | undefined, trustedFileFree = false): string | undefined {
  const access = taskAccess(contract)
  if (access.noNetwork) return '任务禁止执行工具访问网络。此工具没有可核验的离线能力；可使用消息中的数据或已授权的内部材料。'
  if (access.noWorkspaceRead && !trustedFileFree) return '任务禁止读取工作区文件。此工具没有可核验的不读取工作区能力；可使用消息中的数据或已授权的内部材料。'
  return undefined
}
