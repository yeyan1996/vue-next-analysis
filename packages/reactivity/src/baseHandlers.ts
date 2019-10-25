import { reactive, readonly, toRaw } from './reactive'
import { OperationTypes } from './operations'
import { track, trigger } from './effect'
import { LOCKED } from './lock'
import { isObject, hasOwn, isSymbol } from '@vue/shared'
import { isRef } from './ref'

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

function createGetter(isReadonly: boolean) {
  // Vue2 中的 getter，收集依赖
  return function get(target: any, key: string | symbol, receiver: any) {
    /**
     * 如果 get 的属性只存在于原型链
     * Reflect.get 会直接访问原型链，并额外先触发一次原型链上对应属性的 getter
     * 最终会在当前对象和原型链同时收集当前 effect
     * */
    const res = Reflect.get(target, key, receiver)
    // 内建 Symbol 不会进行依赖收集
    if (isSymbol(key) && builtInSymbols.has(key)) {
      return res
    }
    // 如果给 reactive 传入一个值为 ref 的对象 // observed = reactive({a : ref(1)})
    // 并尝试获取 ref 时，会将 ref 解套并返回原始值 // observed.a = 1
    // 如果直接给 reactive 传入一个 ref 会原样返回 // reactive(ref(1))
    if (isRef(res)) {
      return res.value
    }
    // 依赖收集
    track(target, OperationTypes.GET, key)
    // 由于 Proxy 只对最外层对象做代理
    // 所以当访问深层对象时，需要递归对深层对象进行代理操作（Proxy）
    return isObject(res)
      ? isReadonly
        ? // need to lazy access readonly and reactive here to avoid
          // circular dependency
          readonly(res)
        : reactive(res)
      : res
  }
}

function set(
  target: any,
  key: string | symbol,
  value: any,
  receiver: any
): boolean {
  value = toRaw(value)
  // 判断是否
  const hadKey = hasOwn(target, key)
  const oldValue = target[key]
  // 如果给一个 ref 赋值一个非 ref 的值，会将原来的 ref.value 赋值为非 ref 的值
  // observed = reactive({a : ref(1)})
  // observed.a = 2 // ref.value = 2
  if (isRef(oldValue) && !isRef(value)) {
    // 对 ref 的赋值操作会触发 trigger（ref 已经是响应式的了）
    // 所以直接返回，否则会触发两次 trigger
    oldValue.value = value
    return true
  }
  const result = Reflect.set(target, key, value, receiver)
  // don't trigger if target is something up in the prototype chain of original
  // 当触发的是原型链上某个属性的 setter（由 Reflect.set 触发）
  // target 为原型链上的对象，和 receiver 不相等，所以返回 false
  if (target === toRaw(receiver)) {
    /* istanbul ignore else */
    if (__DEV__) {
      const extraInfo = { oldValue, newValue: value }
      // 防止出现多次赋值（例如数组的 push 会触发元素下标的 set 和 length 的 set）
      // vue 进行了判断，保证只触发一次 trigger

      // 当当前 key 在原型链上
      // 或者是对一个不存在的属性的赋值
      if (!hadKey) {
        trigger(target, OperationTypes.ADD, key, extraInfo)
      } else if (value !== oldValue) {
        // 当前 key 是当前对象的属性（非原型链）
        trigger(target, OperationTypes.SET, key, extraInfo)
      }
    } else {
      if (!hadKey) {
        trigger(target, OperationTypes.ADD, key)
      } else if (value !== oldValue) {
        trigger(target, OperationTypes.SET, key)
      }
    }
  }
  return result
}

// 拦截对象的删除操作 delete
function deleteProperty(target: any, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = target[key]
  /**在执行完 Reflect 的方法后，对象上就已经没有这个属性了
   * 也就是说，先删除属性在触发 dep
   * 这样在 effect 执行时对象已没有该属性
   * */
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    /* istanbul ignore else */
    if (__DEV__) {
      trigger(target, OperationTypes.DELETE, key, { oldValue })
    } else {
      trigger(target, OperationTypes.DELETE, key)
    }
  }
  return result
}

function has(target: any, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  track(target, OperationTypes.HAS, key)
  return result
}

// 拦截 for in，Object.keys，Object.getOwnPropertyName 等迭代操作
// for of 不会触发 ownKeys
// 将枚举类型 OperationTypes.ITERATE 作为 key 添加到当前响应式对象到 depMap 中
function ownKeys(target: any): (string | number | symbol)[] {
  track(target, OperationTypes.ITERATE)
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<any> = {
  get: createGetter(false),
  set,
  deleteProperty,
  has,
  ownKeys
}

export const readonlyHandlers: ProxyHandler<any> = {
  get: createGetter(true),

  set(target: any, key: string | symbol, value: any, receiver: any): boolean {
    if (LOCKED) {
      if (__DEV__) {
        console.warn(
          `Set operation on key "${String(key)}" failed: target is readonly.`,
          target
        )
      }
      return true
    } else {
      return set(target, key, value, receiver)
    }
  },

  deleteProperty(target: any, key: string | symbol): boolean {
    if (LOCKED) {
      if (__DEV__) {
        console.warn(
          `Delete operation on key "${String(
            key
          )}" failed: target is readonly.`,
          target
        )
      }
      return true
    } else {
      return deleteProperty(target, key)
    }
  },

  has,
  ownKeys
}
