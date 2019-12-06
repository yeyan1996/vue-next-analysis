import { OperationTypes } from './operations'
import { Dep, targetMap } from './reactive'
import { EMPTY_OBJ, extend } from '@vue/shared'

export const effectSymbol = Symbol(__DEV__ ? 'effect' : void 0)

/**
 * ReactiveEffect 即 Vue2 中的 watcher
 * */
export interface ReactiveEffect<T = any> {
  (): T
  [effectSymbol]: true
  active: boolean
  raw: () => T
  deps: Array<Dep>
  computed?: boolean
  scheduler?: (run: Function) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  computed?: boolean
  scheduler?: (run: Function) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
}

export interface DebuggerEvent {
  effect: ReactiveEffect
  target: any
  type: OperationTypes
  key: string | symbol | undefined
}

export const activeReactiveEffectStack: ReactiveEffect[] = []

export const ITERATE_KEY = Symbol('iterate') // 非 Symbol.iterator，自定义的一个遍历标识位

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn != null && fn[effectSymbol] === true
}

// 创建一个 effect，并立即执行（非 lazy 时）
export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  if (isEffect(fn)) {
    fn = fn.raw
  }
  const effect = createReactiveEffect(fn, options)
  if (!options.lazy) {
    effect()
  }
  return effect
}

// 使一个 effect 停止收集依赖
export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.onStop) {
      effect.onStop()
    }
    effect.active = false
  }
}

function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  // effect 基于传入的参数 fn，同时添加了一些额外属性并返回 effect 函数
  // 返回的 effect 函数支持传参，传入的参数即原始函数接收的参数
  // 并会以 effect 函数的身份运行原始函数（用于 lazy 为 true 的情况）
  const effect = function reactiveEffect(...args: any[]): any {
    return run(effect, fn, args)
  } as ReactiveEffect
  effect[effectSymbol] = true
  effect.active = true
  effect.raw = fn
  effect.scheduler = options.scheduler
  effect.onTrack = options.onTrack
  effect.onTrigger = options.onTrigger
  effect.onStop = options.onStop
  effect.computed = options.computed
  effect.deps = []
  return effect
}

// effect 函数
function run(effect: ReactiveEffect, fn: Function, args: any[]): any {
  if (!effect.active) {
    return fn(...args)
  }
  // 如果在 activeReactiveEffectStack 中已经包含当前 effect 直接返回
  // 避免在 effect 包裹的函数中触发 setter 时再次执行 effect 包裹的函数，导致无线循环
  if (activeReactiveEffectStack.indexOf(effect) === -1) {
    /**
     * 当执行完 effect 返回 effect 函数
     * 之后再通过某个 setter 触发了 effect 函数
     * 会从任何保存了当前 effect 函数的 dep 中删除当前 effect 函数，并准备重新收集
     * */
    cleanup(effect)
    try {
      // 将当前 effect 推入栈顶（activeReactiveEffectStack 为 Vue2 中的全局栈）
      // 以便在执行 fn 的时候给 fn 中的响应式变量收集当前的 effect 作为依赖
      activeReactiveEffectStack.push(effect)
      return fn(...args)
    } finally {
      activeReactiveEffectStack.pop()
    }
  }
}

// 将当前 effect 从所有收集它的 deps 中去除
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true

export function pauseTracking() {
  shouldTrack = false
}

export function resumeTracking() {
  shouldTrack = true
}

// 依赖收集
export function track(
  target: any,
  type: OperationTypes,
  // 响应式对象 target 的某个属性
  key?: string | symbol
) {
  if (!shouldTrack) {
    return
  }
  // 拿到栈顶的 effect 对象
  // effect 就是 Vue2 中的 watcher
  const effect = activeReactiveEffectStack[activeReactiveEffectStack.length - 1]
  if (effect) {
    // 当是一个遍历操作（ownKeys）
    if (type === OperationTypes.ITERATE) {
      key = ITERATE_KEY
    }
    // 当对象被 reactive 方法包裹时（或者 ref）
    // targetMap 中会添加一个元素，键为当前对象，值为空的 Map
    let depsMap = targetMap.get(target)
    if (depsMap === void 0) {
      targetMap.set(target, (depsMap = new Map()))
    }
    // 拿到当前 key 保存的 dep
    let dep = depsMap.get(key!)
    if (dep === void 0) {
      depsMap.set(key!, (dep = new Set()))
    }
    if (!dep.has(effect)) {
      // 往 dep 也就是 Set 集合中添加一个 effect
      dep.add(effect)
      // 给 effect.deps 数组中添加当前 dep，也就是做到互相引用
      // 因为当清除这个 effect 时，需要在所有用到当前 effect 的 dep 中清楚对它的引用
      effect.deps.push(dep)
      if (__DEV__ && effect.onTrack) {
        effect.onTrack({
          effect,
          target,
          type,
          key
        })
      }
    }
  }
}

// 拿到 target 的 key 保存的 dep
// 触发 dep 中保存的 effect
export function trigger(
  target: any,
  type: OperationTypes,
  key?: string | symbol,
  extraInfo?: any
) {
  // 拿到当前响应式对象下面所有的响应式变量和它保存（对应）的 dep
  // 当 target 是 ref 时，获得的 depsMap 只有一个元素，且键名为空字符串
  // 拿到当前响应式对象（或者 ref）中所有属性以及各自保存的 dep
  const depsMap = targetMap.get(target)
  if (depsMap === void 0) {
    // never been tracked
    return
  }
  const effects = new Set<ReactiveEffect>()
  const computedRunners = new Set<ReactiveEffect>()
  if (type === OperationTypes.CLEAR) {
    // collection being cleared, trigger all effects for target
    depsMap.forEach(dep => {
      addRunners(effects, computedRunners, dep)
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      // 根据 effect  的属性（computed effect 或者普通的 effect）
      // 往 effects 和 computedRunners 添加 effect
      addRunners(
        effects,
        computedRunners,
        /**触发 trigger 的 key 对应的 dep 保存的 effect*/ depsMap.get(key)
      )
    }
    // also run for iteration key on ADD | DELETE
    // ADD 和 DELETE 会额外触发 迭代标志位/length 属性中保存的 effect（但由于是 Set 结构所以会自动去重）
    if (type === OperationTypes.ADD || type === OperationTypes.DELETE) {
      // 如果对数组不存在的下标赋值，会直接触发 length 的 setter
      // 如果对对象不存在的属性赋值，会直接触发 ITERATE_KEY 的 setter（for in 会给对象的 ITERATE_KEY 收集当前 effect）
      const iterationKey = Array.isArray(target) ? 'length' : ITERATE_KEY
      addRunners(effects, computedRunners, depsMap.get(iterationKey))
    }
  }
  const run = (effect: ReactiveEffect) => {
    // 执行 effect 的回调
    scheduleRun(effect, target, type, key, extraInfo)
  }
  // Important: computed effects must be run first so that computed getters
  // can be invalidated before any normal effects that depend on them are run.
  // 分别执行 computed effects 和 普通 effects
  /**由于是 Set 结构，即使推入多个相同的 effect 函数，也会被自动去重，始终只触发一个 */
  computedRunners.forEach(run)
  effects.forEach(run)
}

// 将 dep 中的 effect 根据属性，分别放到 effects 和 computedRunners 中
function addRunners(
  effects: Set<ReactiveEffect>,
  computedRunners: Set<ReactiveEffect>,
  effectsToAdd: Set<ReactiveEffect> | undefined
) {
  if (effectsToAdd !== void 0) {
    effectsToAdd.forEach(effect => {
      if (effect.computed) {
        computedRunners.add(effect)
      } else {
        effects.add(effect)
      }
    })
  }
}

function scheduleRun(
  effect: ReactiveEffect,
  target: any,
  type: OperationTypes,
  key: string | symbol | undefined,
  extraInfo: any
) {
  if (__DEV__ && effect.onTrigger) {
    effect.onTrigger(
      extend(
        {
          effect,
          target,
          key,
          type
        },
        extraInfo
      )
    )
  }
  if (effect.scheduler !== void 0) {
    effect.scheduler(effect)
  } else {
    // 当 effect 执行时，执行的为 effect 函数，而非原始函数（79）
    effect()
  }
}
