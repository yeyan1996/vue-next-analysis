import { isObject, toTypeString } from '@vue/shared'
import { mutableHandlers, readonlyHandlers } from './baseHandlers'

import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers
} from './collectionHandlers'

import { UnwrapNestedRefs } from './ref'
import { ReactiveEffect } from './effect'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
// Vue3 中 Dep 被定义为 effect 的集合
export type Dep = Set<ReactiveEffect>
// 键是响应式对象的 key
// 值是 key 保存的 deps 数组
export type KeyToDepMap = Map<string | symbol, Dep>
// 键为响应式对象
// 键也可以是 ref
// 当键是 ref 时， KeyToDepMap 只有一个元素，且它键为空字符串
export const targetMap = new WeakMap<any, KeyToDepMap>()

// WeakMaps that store {raw <-> observed} pairs.
const rawToReactive = new WeakMap<any, any>() // 保存所有代理过的对象，避免多余的代理逻辑
const reactiveToRaw = new WeakMap<any, any>()
const rawToReadonly = new WeakMap<any, any>()
const readonlyToRaw = new WeakMap<any, any>()

// WeakSets for values that are marked readonly or non-reactive during
// observable creation.
const readonlyValues = new WeakSet<any>()
const nonReactiveValues = new WeakSet<any>()

export type CollectionConstructor =
  | SetConstructor
  | MapConstructor
  | WeakMapConstructor
  | WeakSetConstructor
const collectionTypes = new Set<CollectionConstructor>([
  Set,
  Map,
  WeakMap,
  WeakSet
])
const observableValueRE = /^\[object (?:Object|Array|Map|Set|WeakMap|WeakSet)\]$/

const canObserve = (value: any): boolean => {
  return (
    !value._isVue &&
    !value._isVNode &&
    observableValueRE.test(toTypeString(value)) &&
    !nonReactiveValues.has(value)
  )
}

export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  if (readonlyToRaw.has(target)) {
    return target
  }
  // target is explicitly marked as readonly by user
  if (readonlyValues.has(target)) {
    return readonly(target)
  }
  return createReactiveObject(
    target,
    rawToReactive,
    reactiveToRaw,
    mutableHandlers,
    mutableCollectionHandlers
  )
}
// 将当前对象变成一个只读的对象
// 原理是代理 set
export function readonly<T extends object>(
  target: T
): Readonly<UnwrapNestedRefs<T>> {
  // value is a mutable observable, retrieve its original and return
  // a readonly version.
  if (reactiveToRaw.has(target)) {
    target = reactiveToRaw.get(target)
  }
  return createReactiveObject(
    target,
    rawToReadonly,
    readonlyToRaw,
    readonlyHandlers,
    readonlyCollectionHandlers
  )
}

// 根据传入的 handler 参数代理对象
function createReactiveObject(
  target: any,
  toProxy: WeakMap<any, any>,
  toRaw: WeakMap<any, any>,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>
) {
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // target already has corresponding Proxy
  // target 之前被代理过，直接返回缓存中的值
  let observed = toProxy.get(target)
  if (observed !== void 0) {
    return observed
  }
  // target is already a Proxy
  // target 已经是一个 Proxy 直接返回
  if (toRaw.has(target)) {
    return target
  }
  // only a whitelist of value types can be observed.
  if (!canObserve(target)) {
    return target
  }
  // 当前对象是否是 Map,WeakMap,Set,WeakSet 的实例
  // 如果是就对实例的方法做一层拦截（类似 Vue2 对数组的变异方法进行拦截）
  // 使得它们也是一个响应式对象（Proxy 不支持对它们对拦截？）
  const handlers = collectionTypes.has(
    target.constructor as CollectionConstructor
  )
    ? collectionHandlers
    : baseHandlers
  // 新建一个响应式对象
  /**
   * 这里只对最外层做了代理
   * 对于值是对象的属性，在 get 时再递归进行代理
   * 防止循环引用导致卡死
   * */
  observed = new Proxy(target, handlers)
  // toProxy 保存着 <源对象，Proxy 对象> 的组合 (源 to Proxy)
  toProxy.set(target, observed)
  // toRaw 相反
  toRaw.set(observed, target)
  /**给
   *  targetMap 注册当前响应式对象
   *  也就是说一旦对象是一个响应式对象，targetMap 就会有对应的记录，但是值是一个空的 Map
   *  */
  if (!targetMap.has(target)) {
    targetMap.set(target, new Map())
  }
  return observed
}

export function isReactive(value: any): boolean {
  return reactiveToRaw.has(value) || readonlyToRaw.has(value)
}

export function isReadonly(value: any): boolean {
  return readonlyToRaw.has(value)
}

export function toRaw<T>(observed: T): T {
  return reactiveToRaw.get(observed) || readonlyToRaw.get(observed) || observed
}

export function markReadonly<T>(value: T): T {
  readonlyValues.add(value)
  return value
}

export function markNonReactive<T>(value: T): T {
  nonReactiveValues.add(value)
  return value
}
