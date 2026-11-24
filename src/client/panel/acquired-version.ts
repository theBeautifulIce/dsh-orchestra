import type { ArtifactContentView, RunArtifact } from '../api/types.ts'
import { artifactContentKey, matchesArtifactContent } from './artifact-content.tsx'

export type AcquiredVersion = { key: string; mode: 'preview' | 'download' }
export function acquiredVersion(file: RunArtifact, data: ArtifactContentView,
  now = Date.now()): AcquiredVersion | null {
  if (file.expired || (file.retain_until != null && !(Date.parse(file.retain_until) > now))) return null
  if (!matchesArtifactContent(data,file) || (data.kind === 'preview' && data.truncated)) return null
  return {key:artifactContentKey(file),mode:data.kind}
}
export function mayReview(file: RunArtifact, acquired: AcquiredVersion | null,
  completeInCard: boolean, acknowledgedDownload: boolean, now = Date.now()) {
  if (file.expired || (file.retain_until != null && !(Date.parse(file.retain_until) > now))) return false
  return completeInCard || (acquired?.key === artifactContentKey(file) &&
    (acquired.mode === 'preview' || acknowledgedDownload))
}
