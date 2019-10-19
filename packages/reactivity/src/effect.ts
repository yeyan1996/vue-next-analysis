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

export const ITERATE_KEY = Symbol('iterate')

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
  // effect 基于传入的参数 fn，同时添加了一些额外属性
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

function run(effect: ReactiveEffect, fn: Function, args: any[]): any {
  if (!effect.active) {
    return fn(...args)
  }
  if (activeReactiveEffectStack.indexOf(effect) === -1) {
    cleanup(effect)
    try {
      // 将当前 effect 推入栈顶（Vue2 中的全局栈）
      // 以便在执行 fn 的时候给 fn 中的响应式变量收集当前的 effect 作为依赖
      activeReactiveEffectStack.push(effect)
      return fn(...args)
    } finally {
      activeReactiveEffectStack.pop()
    }
  }
}

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
      // effect 中也添加这个 dep，也就是互相引用
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
    // 当触发 set 的 key 不存在，或者是对象原型链上的属性，会触发 ADD
    if (type === OperationTypes.ADD || type === OperationTypes.DELETE) {
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
    effect()
  }
}
