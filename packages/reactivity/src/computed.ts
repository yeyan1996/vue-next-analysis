import { DebuggerOptions, ReactiveEffect } from './effect'
import { Ref, trackRefValue, triggerRefValue } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'
import { Dep } from './dep'

declare const ComoutedRefSymbol: unique symbol

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
  [ComoutedRefSymbol]: true
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (...args: any[]) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

class ComputedRefImpl<T> {
  public dep?: Dep = undefined

  private _value!: T
  private _dirty = true
  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true
  public readonly [ReactiveFlags.IS_READONLY]: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean
  ) {
    // computed 是特殊的 effect
    // 若 effect 包含 scheduler，且被 trigger 时
    // 代替 run 执行 scheduler 函数

    // computed 和其他 ref/响应式对象的区别在于
    // computed 是通过 runner 内部的依赖被修改，做 trigger 通知 effects
    // ref/响应式对象是通过直接修改自身，做 trigger 通知 effects

    // 以下是作为 effect
    this.effect = new ReactiveEffect(getter, () => {
      // 当 dirty（脏）时
      // 证明 computed 依赖的值被修改，需要更新 computed
      // 但此时不会运行 run 计算依赖，取而代之运行 scheduler
      // 通知依赖当前计算属性的 effects 作更新（e.g render effect）
      // scheduler 类似开关，真正触发重新计算是由下面的 get value 实现
      if (!this._dirty) {
        this._dirty = true
        triggerRefValue(this)
      }
    })
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  // 计算属性是特殊的 effect
  // 除了自身可以被其他响应式属性收集(作为 effect)
  // 也可以收集其他 effect（作为响应式属性）

  // 以下是作为响应式属性
  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    const self = toRaw(this)
    // 将当前 activeEffect 作为响应式属性的依赖
    trackRefValue(self)
    // dirty 会缓存值
    // 例如当 render update 时，如果 computed 值没变（dirty = false）
    // 则不会重新运算，使用上一次计算的结果
    if (self._dirty) {
      self._dirty = false
      // 当 runner 运行时
      // 回调函数里的响应式属性会收集 computed effect
      self._value = self.effect.run()!
    }
    return self._value
  }

  set value(newValue: T) {
    this._setter(newValue)
  }
}

export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions
): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  const onlyGetter = isFunction(getterOrOptions)
  if (onlyGetter) {
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  const cRef = new ComputedRefImpl(getter, setter, onlyGetter || !setter)

  if (__DEV__ && debugOptions) {
    cRef.effect.onTrack = debugOptions.onTrack
    cRef.effect.onTrigger = debugOptions.onTrigger
  }

  return cRef as any
}
