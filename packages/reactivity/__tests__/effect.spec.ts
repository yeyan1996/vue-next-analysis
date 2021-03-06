import {
  reactive,
  effect,
  stop,
  toRaw,
  OperationTypes,
  DebuggerEvent,
  markNonReactive
} from '../src/index'
import { ITERATE_KEY } from '../src/effect'

describe('reactivity/effect', () => {
  // effect 包裹的函数会立即执行一次
  it('should run the passed function once (wrapped by a effect)', () => {
    const fnSpy = jest.fn(() => {})
    effect(fnSpy)
    expect(fnSpy).toHaveBeenCalledTimes(1)
  })

  // 在 effect 包裹函数执行前，将当前 effect 推入 activeReactiveEffectStack
  // 在包裹函数执行时，遇到响应式变量（key）会触发 getter(createGetter)
  // 给当前的 key 的 dep 添加栈顶的 effect

  // 当触发响应式变量 (counter.num) 的 setter 时
  // 会从 depsMap 拿到 响应式变量 (counter.num) 对应的 dep
  // 触发 dep 中所有的 effect（run）
  it('should observe basic properties', () => {
    let dummy
    const counter = reactive({ num: 0 })
    effect(() => (dummy = counter.num))

    expect(dummy).toBe(0)
    counter.num = 7
    expect(dummy).toBe(7)
  })

  // 当 counter.num1 触发 setter 时，会触发 num1 对应的 dep 中的所有 effect
  // counter.num2 同理
  it('should observe multiple properties', () => {
    let dummy
    const counter = reactive({ num1: 0, num2: 0 })
    effect(() => {
      dummy = counter.num1 + counter.num1 + counter.num2
    })

    expect(dummy).toBe(0)
    counter.num1 = counter.num2 = 7
    expect(dummy).toBe(21)
  })

  it('should handle multiple effects', () => {
    let dummy1, dummy2
    const counter = reactive({ num: 0 })
    effect(() => (dummy1 = counter.num))
    effect(() => (dummy2 = counter.num))

    expect(dummy1).toBe(0)
    expect(dummy2).toBe(0)
    counter.num++
    expect(dummy1).toBe(1)
    expect(dummy2).toBe(1)
  })

  // 最终无论多深，都会递归的进行代理
  // 在给深层对象的属性赋值时，会先触发父级对象的 getter 再触发属性的 setter
  // 这里即先触发 nested 的 getter，再触发 num 的 setter
  // 当触发父级对象的 getter 时，会查找保存所有代理对象的 Map(rawToReactive)
  // 若 Map 中没有代理过，就给父级对象做代理
  it('should observe nested properties', () => {
    let dummy
    const counter = reactive({ nested: { num: 0 } })
    effect(() => (dummy = counter.nested.num))

    expect(dummy).toBe(0)
    counter.nested.num = 8
    expect(dummy).toBe(8)
  })

  // 由于 Proxy 可以拦截对象 delete 属性的操作
  // 和赋值一样会执行 run，触发删除的属性对应的 dep 中的所有 effect
  it('should observe delete operations', () => {
    let dummy
    const obj = reactive({ prop: 'value' })
    effect(() => (dummy = obj.prop))

    expect(dummy).toBe('value')
    delete obj.prop
    expect(dummy).toBe(undefined)
  })

  // Vue3 先会删除属性，再触发 dep（set,get,has 同理）
  // 也就说先删除属性，再执行 effect 中的函数
  // 同时基于 Proxy 的响应式可以监听对象根属性的添加
  it('should observe has operations', () => {
    let dummy
    const obj = reactive<{ prop: string | number }>({ prop: 'value' })
    effect(() => {
      dummy = 'prop' in obj
    })

    expect(dummy).toBe(true)
    delete obj.prop
    expect(dummy).toBe(false)
    obj.prop = 12
    expect(dummy).toBe(true)
  })
  // 当在对象的原型链上存在同名的变量时, 删除在对象的那个属性
  // 会触发 deleteProperty 重新执行 effect 中的函数并重新收集依赖
  // 第一次收集的是 { num: 0 } ，而删除 num 后，再次收集到的则是 { num: 2 }
  // 所以当 { num: 2 } 被修改时，也会触发 effect 中的函数
  it('should observe properties on the prototype chain', () => {
    let dummy
    const counter = reactive({ num: 0 })
    const parentCounter = reactive({ num: 2 })
    Object.setPrototypeOf(counter, parentCounter)
    effect(() => (dummy = counter.num))

    expect(dummy).toBe(0)
    delete counter.num
    expect(dummy).toBe(2)
    parentCounter.num = 4
    expect(dummy).toBe(4)
    counter.num = 3
    expect(dummy).toBe(3)
  })

  // 同上
  it('should observe has operations on the prototype chain', () => {
    let dummy
    const counter = reactive({ num: 0 })
    const parentCounter = reactive({ num: 2 })
    Object.setPrototypeOf(counter, parentCounter)
    effect(() => (dummy = 'num' in counter))

    expect(dummy).toBe(true)
    delete counter.num
    expect(dummy).toBe(true)
    delete parentCounter.num
    expect(dummy).toBe(false)
    counter.num = 3
    expect(dummy).toBe(true)
  })

  it('should observe inherited property accessors', () => {
    let dummy, parentDummy, hiddenValue: any
    const obj = reactive<{ prop?: number }>({})
    const parent = reactive({
      set prop(value) {
        hiddenValue = value
      },
      get prop() {
        return hiddenValue
      }
    })
    Object.setPrototypeOf(obj, parent)
    // 虽然 obj 中没有 prop
    // 但是会触发 obj 的 get，给 obj 对应的 depsMap 注册一个 prop 属性
    // prop 属性对应的 dep 添加当前的 effect

    // 同时由于 obj 中没有 prop
    // 但是内部触发了 Reflect.get ，访问到了原型链上的 prop 属性
    // 最终会还会给原型链上的 prop 添加当前 effect
    effect(() => (dummy = obj.prop)) // obj.prop 和 parent.prop (obj.__proto__.prop) 都会保存这个 effect
    effect(() => (parentDummy = parent.prop)) // 只有一个 parent.prop (obj.__proto.prop) 保存这个 effect

    expect(dummy).toBe(undefined)
    expect(parentDummy).toBe(undefined)
    // 以下操作会触发原型链上的 prop 的 setter，并不会给 obj.prop 赋值
    // 然后由于 Vue 的一些操作（第一个 effect 的第一段），使得第一个 effect 也会触发
    obj.prop = 4
    expect(dummy).toBe(4)
    // this doesn't work, should it?
    // expect(parentDummy).toBe(4)
    parent.prop = 2
    expect(dummy).toBe(2)
    expect(parentDummy).toBe(2)
    // 由于在原型链上有 prop 的 setter
    // 所以即使全部执行完，obj 仍没有 prop 属性
  })

  // 由于在执行 effect 的时候已经将栈顶的元素设置为当前的 effect
  // 所以在 effect 包裹的函数执行时，所有响应式变量触发的 getter 都会添加当前的 effect
  // 同时在函数执行完毕后，会弹出当前 effect
  it('should observe function call chains', () => {
    let dummy
    const counter = reactive({ num: 0 })
    effect(() => (dummy = getNum()))

    function getNum() {
      return counter.num
    }

    expect(dummy).toBe(0)
    counter.num = 2
    expect(dummy).toBe(2)
  })

  // 只有 effect 包裹的函数执行的时候
  // 才会给对应响应式变量添加当前 effect

  /**
   * 当代理一个数组时，触发数组的方法会同时触发方法的 getter 和 length 的 getter
   * 因为数组的方法需要访问 length
   * 同时还可能触发对应下标的 getter/setter，以及相邻下标的 has/getter(shift,pop)
   * */
  it('should observe iteration', () => {
    let dummy
    const list = reactive(['Hello'])
    effect(() => (dummy = list.join(' ')))

    expect(dummy).toBe('Hello')
    // list.push 会先触发 push 的 getter,length 的 getter
    // 但是此时没有 effect 所以不会收集任何依赖

    // 然后触发下标 1 的 setter，length 的 setter
    // 当触发下标 1 的 setter 时，由于是对不存在的 key 的赋值
    // 所以会进行判断，如果是数组类型则替换，并触发 length 这个响应式变量保存的 effect
    // 重新收集依赖，也就是给下标 1 添加当前 effect

    // 当 length 属性触发 setter 时，由于新旧数组相同，则直接 return
    list.push('World!')
    expect(dummy).toBe('Hello World!')

    /* list.shift 会依次触发
        shift 的 getter
        length 的 getter
        下标 0 的 getter
        下标 1 的 has
        下标 1 的 getter
        下标 0 的 setter
        下标 1 的 delete
        length 的 setter
    */
    // 数组的出列相对比较耗费性能
    // 因为需要让所有下标都向前一位，所有涉及到的元素下标会同时触发 getter 和 setter
    // 这里还触发了 has（in），确保存在改属性
    // 同时删除最后一位元素（delete），并修改 length
    // set 和 delete 都会触发 effect
    list.shift()
    expect(dummy).toBe('World!')
  })

  // 当执行 join 时会触发 join 的 getter 和 length 的 getter
  // 当给数组不存在的属性进行赋值时，会直接触发 ITERATE 属性，即 length 的 setter
  // 重新触发 effect
  it('should observe implicit array length changes', () => {
    let dummy
    const list = reactive(['Hello'])
    effect(() => (dummy = list.join(' ')))

    expect(dummy).toBe('Hello')
    list[1] = 'World!'
    expect(dummy).toBe('Hello World!')
    list[3] = 'Hello!'
    expect(dummy).toBe('Hello World!  Hello!')
  })

  /**如果给数组下标赋值，则不会触发 length 相关的 getter 和 setter*/
  it('should observe sparse array mutations', () => {
    let dummy
    const list = reactive<string[]>([])
    // 由于没有被 effect 包裹，所以这里触发 setter 不会有任何变化
    list[1] = 'World!'
    // 将 length 和 join 放入list 的 depMap 中作为键
    effect(() => (dummy = list.join(' ')))
    expect(dummy).toBe(' World!')
    // 0 不存在，所以触发 length 的 setter
    list[0] = 'Hello'
    expect(dummy).toBe('Hello World!')
    // 依次触发 pop 的 getter
    // length 的 getter
    // 1 的 getter
    // 1 的 delete
    // length 的 setter
    list.pop()
    expect(dummy).toBe('Hello')
  })

  it('should observe enumeration', () => {
    let dummy = 0
    const numbers = reactive<Record<string, number>>({ num1: 3 })
    effect(() => {
      dummy = 0
      for (let key in numbers) {
        dummy += numbers[key]
      }
    })

    expect(dummy).toBe(3)
    // 当给对象添加一个不存在的 key
    // Vue 会替换为 ITERATE_KEY 的 setter
    numbers.num2 = 4
    expect(dummy).toBe(7)
    delete numbers.num1
    expect(dummy).toBe(4)
  })

  // 第一个 effect 执行时，触发 Symbol key 的 getter ，添加当前 effect
  // 第二个 effect 执行时，触发 has 给 Symbol key 添加当前 effect
  // 最终 Symbol key 保存 2 个 effect
  it('should observe symbol keyed properties', () => {
    const key = Symbol('symbol keyed prop')
    let dummy, hasDummy
    const obj = reactive({ [key]: 'value' })
    effect(() => (dummy = obj[key]))
    effect(() => (hasDummy = key in obj))

    expect(dummy).toBe('value')
    expect(hasDummy).toBe(true)
    obj[key] = 'newValue'
    expect(dummy).toBe('newValue')
    delete obj[key]
    expect(dummy).toBe(undefined)
    expect(hasDummy).toBe(false)
  })

  // 内建 Symbol 不会进行依赖收集，所以不会收集 effect
  // 当 dummy 改变后，由于是数组不存在的 key
  // 所以触发 length 的 setter
  it('should not observe well-known symbol keyed properties', () => {
    const key = Symbol.isConcatSpreadable
    let dummy
    const array: any = reactive([])
    effect(() => (dummy = array[key]))

    expect(array[key]).toBe(undefined)
    expect(dummy).toBe(undefined)
    array[key] = true
    expect(array[key]).toBe(true)
    expect(dummy).toBe(undefined)
  })

  it('should observe function valued properties', () => {
    const oldFunc = () => {}
    const newFunc = () => {}

    let dummy
    const obj = reactive({ func: oldFunc })
    effect(() => (dummy = obj.func))

    expect(dummy).toBe(oldFunc)
    obj.func = newFunc
    expect(dummy).toBe(newFunc)
  })

  // 赋值相同则不会触发 effect
  it('should not observe set operations without a value change', () => {
    let hasDummy, getDummy
    const obj = reactive({ prop: 'value' })

    const getSpy = jest.fn(() => (getDummy = obj.prop))
    const hasSpy = jest.fn(() => (hasDummy = 'prop' in obj))
    effect(getSpy)
    effect(hasSpy)

    expect(getDummy).toBe('value')
    expect(hasDummy).toBe(true)
    obj.prop = 'value'
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(hasSpy).toHaveBeenCalledTimes(1)
    expect(getDummy).toBe('value')
    expect(hasDummy).toBe(true)
  })

  // raw 对象没有设置 Proxy，所以没有拦截器不会收集依赖
  it('should not observe raw mutations', () => {
    let dummy
    const obj = reactive<{ prop?: string }>({})
    effect(() => (dummy = toRaw(obj).prop))

    expect(dummy).toBe(undefined)
    obj.prop = 'value'
    expect(dummy).toBe(undefined)
  })

  // raw 对象没有设置 Proxy，所以没有拦截器不会触发 effect
  it('should not be triggered by raw mutations', () => {
    let dummy
    const obj = reactive<{ prop?: string }>({})
    effect(() => (dummy = obj.prop))

    expect(dummy).toBe(undefined)
    toRaw(obj).prop = 'value'
    expect(dummy).toBe(undefined)
  })

  it('should not be triggered by inherited raw setters', () => {
    let dummy, parentDummy, hiddenValue: any
    const obj = reactive<{ prop?: number }>({})
    const parent = reactive({
      set prop(value) {
        hiddenValue = value
      },
      get prop() {
        return hiddenValue
      }
    })
    /** 当给代理对象设置原型时，原对象也会被设置*/
    Object.setPrototypeOf(obj, parent)
    effect(() => (dummy = obj.prop))
    effect(() => (parentDummy = parent.prop))

    expect(dummy).toBe(undefined)
    expect(parentDummy).toBe(undefined)
    // 由于触发 setter 的属性在原型链上，并不会触发 effect
    toRaw(obj).prop = 4
    expect(dummy).toBe(undefined)
    expect(parentDummy).toBe(undefined)
  })

  // counter.num++ 可以理解为 counter.num = counter.num + 1
  // 所以在 effect 运行时 num 属性会收集 effect

  // 在 effect 包裹的函数执行时，activeReactiveEffectStack 栈顶为当前 effect
  // vue 会进行判断，如果栈顶的 effect 等于 setter 触发的 effect，则不会重复触发这个 effect
  // 所以包裹的函数不会被重复执行
  it('should avoid implicit infinite recursive loops with itself', () => {
    const counter = reactive({ num: 0 })

    const counterSpy = jest.fn(() => counter.num++)
    effect(counterSpy)
    expect(counter.num).toBe(1)
    expect(counterSpy).toHaveBeenCalledTimes(1)
    counter.num = 4
    expect(counter.num).toBe(5)
    expect(counterSpy).toHaveBeenCalledTimes(2)
  })

  // 虽然 setter 触发的 effect 不会重复
  // 但是函数内部主动递归调用仍可以触发
  it('should allow explicitly recursive raw function loops', () => {
    const counter = reactive({ num: 0 })
    const numSpy = jest.fn(() => {
      counter.num++
      if (counter.num < 10) {
        numSpy()
      }
    })
    effect(numSpy)
    expect(counter.num).toEqual(10)
    expect(numSpy).toHaveBeenCalledTimes(10)
  })

  it('should avoid infinite loops with other effects', () => {
    const nums = reactive({ num1: 0, num2: 1 })

    const spy1 = jest.fn(() => (nums.num1 = nums.num2)) // nums.nums2 保存了 spy1
    const spy2 = jest.fn(() => (nums.num2 = nums.num1)) // nums.num1 保存了 spy2
    effect(spy1)
    // 由于赋值前后值没有变所以不会触发 effect
    effect(spy2)
    expect(nums.num1).toBe(1)
    expect(nums.num2).toBe(1)
    expect(spy1).toHaveBeenCalledTimes(1)
    expect(spy2).toHaveBeenCalledTimes(1)
    nums.num2 = 4
    expect(nums.num1).toBe(4)
    expect(nums.num2).toBe(4)
    expect(spy1).toHaveBeenCalledTimes(2)
    expect(spy2).toHaveBeenCalledTimes(2)
    nums.num1 = 10
    expect(nums.num1).toBe(10)
    expect(nums.num2).toBe(10)
    expect(spy1).toHaveBeenCalledTimes(3)
    expect(spy2).toHaveBeenCalledTimes(3)
  })

  // effect 执行前包裹的函数叫原函数
  // effect 执行时包裹的函数叫 effect 函数
  // 原函数和 effect 函数并不是同一个函数，因为 effect 函数含有一些关于 effect 的额外属性
  // 并且每次调用 effect 都会创建一个 "effect 函数" 所以并不是内存中的同一个对象
  it('should return a new reactive version of the function', () => {
    function greet() {
      return 'Hello World'
    }
    const effect1 = effect(greet)
    const effect2 = effect(greet)
    expect(typeof effect1).toBe('function')
    expect(typeof effect2).toBe('function')
    expect(effect1).not.toBe(greet)
    expect(effect1).not.toBe(effect2)
  })

  it('should discover new branches while running automatically', () => {
    let dummy
    const obj = reactive({ prop: 'value', run: false })

    const conditionalSpy = jest.fn(() => {
      dummy = obj.run ? obj.prop : 'other'
    })
    // run 属性收集了当前 effect
    effect(conditionalSpy)

    expect(dummy).toBe('other')
    expect(conditionalSpy).toHaveBeenCalledTimes(1)
    // prop 属性中并没有 effect函数，所以触发 setter 时 effect 函数也不会运行
    obj.prop = 'Hi'
    expect(dummy).toBe('other')
    expect(conditionalSpy).toHaveBeenCalledTimes(1)
    // 当 run 为 true 时，会触发 setter，即触发 effect 函数
    // 此时 prop 属性就会收集当前 effect 函数
    // 最终 run 和 prop 的 dep 中都会有当前的 effect 函数
    obj.run = true
    expect(dummy).toBe('Hi')
    expect(conditionalSpy).toHaveBeenCalledTimes(2)
    obj.prop = 'World'
    expect(dummy).toBe('World')
    expect(conditionalSpy).toHaveBeenCalledTimes(3)
  })

  it('should discover new branches when running manually', () => {
    let dummy
    let run = false
    const obj = reactive({ prop: 'value' })
    const runner = effect(() => {
      dummy = run ? obj.prop : 'other'
    })

    expect(dummy).toBe('other')
    runner()
    expect(dummy).toBe('other')
    // 由于 run 不是一个响应式变量，所以即使赋值为 true 也不会触发 effect 函数
    run = true
    // 手动触发 effect 函数会重新收集依赖
    // 给 prop 添加当前 effect
    runner()
    expect(dummy).toBe('value')
    obj.prop = 'World'
    expect(dummy).toBe('World')
  })

  it('should not be triggered by mutating a property, which is used in an inactive branch', () => {
    let dummy
    const obj = reactive({ prop: 'value', run: true })

    const conditionalSpy = jest.fn(() => {
      dummy = obj.run ? obj.prop : 'other'
    })
    effect(conditionalSpy)

    expect(dummy).toBe('value')
    expect(conditionalSpy).toHaveBeenCalledTimes(1)
    // 此时通过 setter 重新执行 effect 函数时会执行 cleanup
    /**从任何含有当前 effect 的 dep 中删除当前 effect，并准备重新收集*/
    obj.run = false
    expect(dummy).toBe('other')
    expect(conditionalSpy).toHaveBeenCalledTimes(2)
    // 由于重新收集依赖时 run 为 false，所以不会给 prop 属性收集当前 effect 函数
    obj.prop = 'value2'
    expect(dummy).toBe('other')
    expect(conditionalSpy).toHaveBeenCalledTimes(2)
  })

  // 在原始函数变为 effect 函数时，会定义 raw 属性保存原来的函数
  // 当给 effect 再次传入一个 effect 函数，会进行判断（通过 effectSymbol 标识位来判断）
  // 如果已经是一个 effect 函数则直接返回 raw，即不会多次包裹
  it('should not double wrap if the passed function is a effect', () => {
    const runner = effect(() => {})
    const otherRunner = effect(runner)
    expect(runner).not.toBe(otherRunner)
    expect(runner.raw).toBe(otherRunner.raw)
  })
    // 由于 key 的 dep 是一个 Set 结构，会自动去重相同的 effect
    // 所以 prop 赋值只会触发 effect 一次
  it('should not run multiple times for a single mutation', () => {
    let dummy
    const obj = reactive<Record<string, number>>({})
    const fnSpy = jest.fn(() => {
        // obj 为空对象也会触发 ownKeys 拦截
      for (const key in obj) {
        dummy = obj[key]
      }
      dummy = obj.prop
    })
    effect(fnSpy)

    expect(fnSpy).toHaveBeenCalledTimes(1)
      // 不存在的 key 将会触发 ITERATE 属性对应的 dep
    obj.prop = 16
    expect(dummy).toBe(16)
    expect(fnSpy).toHaveBeenCalledTimes(2)
  })

  it('should allow nested effects', () => {
    const nums = reactive({ num1: 0, num2: 1, num3: 2 })
    const dummy: any = {}

    const childSpy = jest.fn(() => (dummy.num1 = nums.num1))
    const childeffect = effect(childSpy)
    const parentSpy = jest.fn(() => {
      dummy.num2 = nums.num2
      childeffect()
      dummy.num3 = nums.num3
    })
    effect(parentSpy)

    expect(dummy).toEqual({ num1: 0, num2: 1, num3: 2 })
    expect(parentSpy).toHaveBeenCalledTimes(1)
    expect(childSpy).toHaveBeenCalledTimes(2)
    // this should only call the childeffect
    nums.num1 = 4
    expect(dummy).toEqual({ num1: 4, num2: 1, num3: 2 })
    expect(parentSpy).toHaveBeenCalledTimes(1)
    expect(childSpy).toHaveBeenCalledTimes(3)
    // this calls the parenteffect, which calls the childeffect once
    nums.num2 = 10
    expect(dummy).toEqual({ num1: 4, num2: 10, num3: 2 })
    expect(parentSpy).toHaveBeenCalledTimes(2)
    expect(childSpy).toHaveBeenCalledTimes(4)
    // this calls the parenteffect, which calls the childeffect once
    nums.num3 = 7
    expect(dummy).toEqual({ num1: 4, num2: 10, num3: 7 })
    expect(parentSpy).toHaveBeenCalledTimes(3)
    expect(childSpy).toHaveBeenCalledTimes(5)
  })

  it('should observe class method invocations', () => {
    class Model {
      count: number
      constructor() {
        this.count = 0
      }
      inc() {
        this.count++
      }
    }
    const model = reactive(new Model())
    let dummy
    effect(() => {
      dummy = model.count
    })
    expect(dummy).toBe(0)
    model.inc()
    expect(dummy).toBe(1)
  })

  it('lazy', () => {
    const obj = reactive({ foo: 1 })
    let dummy
    const runner = effect(() => (dummy = obj.foo), { lazy: true })
    expect(dummy).toBe(undefined)

    expect(runner()).toBe(1)
    expect(dummy).toBe(1)
    obj.foo = 2
    expect(dummy).toBe(2)
  })

  it('scheduler', () => {
    let runner: any, dummy
    const scheduler = jest.fn(_runner => {
      runner = _runner
    })
    const obj = reactive({ foo: 1 })
    effect(
      () => {
        dummy = obj.foo
      },
      { scheduler }
    )
    expect(scheduler).not.toHaveBeenCalled()
    expect(dummy).toBe(1)
    // should be called on first trigger
    obj.foo++
    expect(scheduler).toHaveBeenCalledTimes(1)
    // should not run yet
    expect(dummy).toBe(1)
    // manually run
    runner()
    // should have run
    expect(dummy).toBe(2)
  })

  it('events: onTrack', () => {
    let events: DebuggerEvent[] = []
    let dummy
    const onTrack = jest.fn((e: DebuggerEvent) => {
      events.push(e)
    })
    const obj = reactive({ foo: 1, bar: 2 })
    const runner = effect(
      () => {
        dummy = obj.foo
        dummy = 'bar' in obj
        dummy = Object.keys(obj)
      },
      { onTrack }
    )
    expect(dummy).toEqual(['foo', 'bar'])
    expect(onTrack).toHaveBeenCalledTimes(3)
    expect(events).toEqual([
      {
        effect: runner,
        target: toRaw(obj),
        type: OperationTypes.GET,
        key: 'foo'
      },
      {
        effect: runner,
        target: toRaw(obj),
        type: OperationTypes.HAS,
        key: 'bar'
      },
      {
        effect: runner,
        target: toRaw(obj),
        type: OperationTypes.ITERATE,
        key: ITERATE_KEY
      }
    ])
  })

  it('events: onTrigger', () => {
    let events: DebuggerEvent[] = []
    let dummy
    const onTrigger = jest.fn((e: DebuggerEvent) => {
      events.push(e)
    })
    const obj = reactive({ foo: 1 })
    const runner = effect(
      () => {
        dummy = obj.foo
      },
      { onTrigger }
    )

    obj.foo++
    expect(dummy).toBe(2)
    expect(onTrigger).toHaveBeenCalledTimes(1)
    expect(events[0]).toEqual({
      effect: runner,
      target: toRaw(obj),
      type: OperationTypes.SET,
      key: 'foo',
      oldValue: 1,
      newValue: 2
    })

    delete obj.foo
    expect(dummy).toBeUndefined()
    expect(onTrigger).toHaveBeenCalledTimes(2)
    expect(events[1]).toEqual({
      effect: runner,
      target: toRaw(obj),
      type: OperationTypes.DELETE,
      key: 'foo',
      oldValue: 2
    })
  })

  it('stop', () => {
    let dummy
    const obj = reactive({ prop: 1 })
    const runner = effect(() => {
      dummy = obj.prop
    })
    obj.prop = 2
    expect(dummy).toBe(2)
    stop(runner)
    obj.prop = 3
    expect(dummy).toBe(2)

    // stopped effect should still be manually callable
    runner()
    expect(dummy).toBe(3)
  })

  it('events: onStop', () => {
    const runner = effect(() => {}, {
      onStop: jest.fn()
    })

    stop(runner)
    expect(runner.onStop).toHaveBeenCalled()
  })

  it('markNonReactive', () => {
    const obj = reactive({
      foo: markNonReactive({
        prop: 0
      })
    })
    let dummy
    effect(() => {
      dummy = obj.foo.prop
    })
    expect(dummy).toBe(0)
    obj.foo.prop++
    expect(dummy).toBe(0)
    obj.foo = { prop: 1 }
    expect(dummy).toBe(1)
  })
})
