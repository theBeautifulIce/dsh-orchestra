import { COLOR } from './tokens.ts'

function channels(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new TypeError(`Invalid color: ${hex}`)
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number]
}

export function relativeLuminance(hex: string): number {
  const linearize = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  const [r0, g0, b0] = channels(hex)
  const r = linearize(r0)
  const g = linearize(g0)
  const b = linearize(b0)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export const TEXT_PAIRS = [
  { fg: COLOR.ink, bg: COLOR.canvas, floor: 4.5, label: '正文' },
  { fg: COLOR.inkMuted, bg: COLOR.canvas, floor: 4.5, label: '辅助文字' },
  { fg: COLOR.success, bg: COLOR.canvas, floor: 4.5, label: '成功状态文字' },
  { fg: COLOR.warning, bg: COLOR.canvas, floor: 4.5, label: '警告状态文字' },
  { fg: COLOR.danger, bg: COLOR.canvas, floor: 4.5, label: '危险状态文字' },
  { fg: COLOR.link, bg: COLOR.canvas, floor: 3, label: '链接' },
] as const
