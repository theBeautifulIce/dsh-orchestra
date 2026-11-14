// src/core/freeze.ts —— 深冻结：让内存里的工作流定义真的改不动（第二次意见 P1：不可变性要落到对象本身）

/**
 * 递归冻结对象与数组：冻结之后不能再改属性、不能增删元素、也不能替换嵌套对象。
 * 工作流定义目录靠它守住「同一版本只有一份定义」——外部拿到的引用改不动目录里的本体。
 */
export function deepFreeze<T>(value: T): T {
  return freezeInner(value, new WeakSet<object>())
}

function freezeInner<T>(value: T, seen: WeakSet<object>): T {
  // 基本类型没有可冻的属性，直接放行
  if (value === null || typeof value !== 'object') return value
  const obj = value as unknown as Record<string, unknown>
  // 见过就跳过：万一以后有人把带环的对象传进来，也不会冻到栈溢出
  if (seen.has(obj)) return value
  seen.add(obj)
  // 从叶子往上冻：父对象先冻上不影响子对象，但子对象冻完父对象才冻得住整棵树
  for (const key of Object.keys(obj)) {
    freezeInner(obj[key], seen)
  }
  Object.freeze(value)
  return value
}
