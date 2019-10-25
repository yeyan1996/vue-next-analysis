import { effect, ReactiveEffect, activeReactiveEffectStack } from './effect'
import { Ref, refSymbol, UnwrapRef } from './ref'
import { isFunction, NOOP } from '@vue/shared'

export interface ComputedRef<T> extends WritableComputedRef<T> {
  readonly value: UnwrapRef<T>
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect
}

export interface WritableComputedOptions<T> {
  get: () => T
  set: (v: T) => void
}

export function computed<T>(getter: () => T): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: (() => T) | WritableComputedOptions<T>
): any {
  const isReadonly = isFunction(getterOrOptions)
  const getter = isReadonly
    ? (getterOrOptions as (() => T))
    : (getterOrOptions as WritableComputedOptions<T>).get
  const setter = isReadonly
    ? __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
    : (getterOrOptions as WritableComputedOptions<T>).set

  let dirty = true
  let value: T

  const runner = effect(getter, {
    lazy: true,
    // mark effect as computed so that it gets priority during trigger
    computed: true,
    // computed effect 函数在依赖项触发 setter 时候不会执行
    // 取而代之将 computed effect dirty 设置为 true
    // 直到触发了计算属性的 getter 才会进行求值
    scheduler: () => {
      dirty = true
    }
  })
  // computed effect 执行后返回一个 computed ref
  return {
    [refSymbol]: true,
    // expose effect so computed can be stopped
    effect: runner,
    get value() {
      if (dirty) {
        value = runner()
        dirty = false
      }
      // When computed effects are accessed in a parent effect, the parent
      // should track all the dependencies the computed property has tracked.
      // This should also apply for chained computed properties.
      trackChildRun(runner)
      return value
    },
    set value(newValue: T) {
      setter(newValue)
    }
  }
}
// 如果 effect 执行时收集到了一个 computed ref 时
// 会给 ref 对应的 computed effect 函数中保存的所有 dep 收集当前 effect
// 类似 vue2 中 computed watcher 的 depend 方法
function trackChildRun(childRunner: ReactiveEffect) {
  // 此时栈顶为当前的 effect
  const parentRunner =
    activeReactiveEffectStack[activeReactiveEffectStack.length - 1]
  if (parentRunner) {
    for (let i = 0; i < childRunner.deps.length; i++) {
      const dep = childRunner.deps[i]
      if (!dep.has(parentRunner)) {
        dep.add(parentRunner)
        parentRunner.deps.push(dep)
      }
    }
  }
}
