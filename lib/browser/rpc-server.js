const electron = require('electron')
const v8Util = process.atomBinding('v8_util')

const {ipcMain, isPromise} = electron

const objectsRegistry = require('./objects-registry')
const bufferUtils = require('../common/buffer-utils')

const hasProp = {}.hasOwnProperty

// The internal properties of Function.
const FUNCTION_PROPERTIES = [
  'length', 'name', 'arguments', 'caller', 'prototype'
]

// The remote functions in renderer processes.
// id => Function
let rendererFunctions = v8Util.createDoubleIDWeakMap()

// Return the description of object's members:
let getObjectMembers = function (object) {
  let names = Object.getOwnPropertyNames(object)
  // For Function, we should not override following properties even though they
  // are "own" properties.
  if (typeof object === 'function') {
    names = names.filter((name) => {
      return !FUNCTION_PROPERTIES.includes(name)
    })
  }
  // Map properties to descriptors.
  return names.map((name) => {
    let descriptor = Object.getOwnPropertyDescriptor(object, name)
    let member = {name, enumerable: descriptor.enumerable, writable: false}
    if (descriptor.get === undefined && typeof object[name] === 'function') {
      member.type = 'method'
    } else {
      if (descriptor.set || descriptor.writable) member.writable = true
      member.type = 'get'
    }
    return member
  })
}

// Return the description of object's prototype.
let getObjectPrototype = function (object) {
  let proto = Object.getPrototypeOf(object)
  if (proto === null || proto === Object.prototype) return null
  return {
    members: getObjectMembers(proto),
    proto: getObjectPrototype(proto)
  }
}

// Convert a real value into meta data.
let valueToMeta = function (sender, contextId, value, optimizeSimpleObject = false) {
  // Determine the type of value.
  const meta = { type: typeof value }
  if (meta.type === 'object') {
    // Recognize certain types of objects.
    if (value === null) {
      meta.type = 'value'
    } else if (bufferUtils.isBuffer(value)) {
      meta.type = 'buffer'
    } else if (Array.isArray(value)) {
      meta.type = 'array'
    } else if (value instanceof Error) {
      meta.type = 'error'
    } else if (value instanceof Date) {
      meta.type = 'date'
    } else if (isPromise(value)) {
      meta.type = 'promise'
    } else if (hasProp.call(value, 'callee') && value.length != null) {
      // Treat the arguments object as array.
      meta.type = 'array'
    } else if (optimizeSimpleObject && v8Util.getHiddenValue(value, 'simple')) {
      // Treat simple objects as value.
      meta.type = 'value'
    }
  }

  // Fill the meta object according to value's type.
  if (meta.type === 'array') {
    meta.members = value.map((el) => valueToMeta(sender, contextId, el, optimizeSimpleObject))
  } else if (meta.type === 'object' || meta.type === 'function') {
    meta.name = value.constructor ? value.constructor.name : ''

    // Reference the original value if it's an object, because when it's
    // passed to renderer we would assume the renderer keeps a reference of
    // it.
    meta.id = objectsRegistry.add(sender, contextId, value)
    meta.members = getObjectMembers(value)
    meta.proto = getObjectPrototype(value)
  } else if (meta.type === 'buffer') {
    meta.value = bufferUtils.bufferToMeta(value)
  } else if (meta.type === 'promise') {
    // Add default handler to prevent unhandled rejections in main process
    // Instead they should appear in the renderer process
    value.then(function () {}, function () {})

    meta.then = valueToMeta(sender, contextId, function (onFulfilled, onRejected) {
      value.then(onFulfilled, onRejected)
    })
  } else if (meta.type === 'error') {
    meta.members = plainObjectToMeta(value)

    // Error.name is not part of own properties.
    meta.members.push({
      name: 'name',
      value: value.name
    })
  } else if (meta.type === 'date') {
    meta.value = value.getTime()
  } else {
    meta.type = 'value'
    meta.value = value
  }
  return meta
}

// Convert object to meta by value.
const plainObjectToMeta = function (obj) {
  return Object.getOwnPropertyNames(obj).map(function (name) {
    return {
      name: name,
      value: obj[name]
    }
  })
}

// Convert Error into meta data.
const exceptionToMeta = function (sender, contextId, error) {
  return {
    type: 'exception',
    message: error.message,
    stack: error.stack || error,
    cause: valueToMeta(sender, contextId, error.cause)
  }
}

const throwRPCError = function (message) {
  const error = new Error(message)
  error.code = 'EBADRPC'
  error.errno = -72
  throw error
}

// Convert array of meta data from renderer into array of real values.
const unwrapArgs = function (sender, contextId, args) {
  const metaToValue = function (meta) {
    let i, len, member, ref, returnValue
    switch (meta.type) {
      case 'value':
        return meta.value
      case 'remote-object':
        return objectsRegistry.get(meta.id)
      case 'array':
        return unwrapArgs(sender, contextId, meta.value)
      case 'buffer':
        return bufferUtils.metaToBuffer(meta.value)
      case 'date':
        return new Date(meta.value)
      case 'promise':
        return Promise.resolve({
          then: metaToValue(meta.then)
        })
      case 'object': {
        let ret = {}
        Object.defineProperty(ret.constructor, 'name', { value: meta.name })

        ref = meta.members
        for (i = 0, len = ref.length; i < len; i++) {
          member = ref[i]
          ret[member.name] = metaToValue(member.value)
        }
        return ret
      }
      case 'function-with-return-value':
        returnValue = metaToValue(meta.value)
        return function () {
          return returnValue
        }
      case 'function': 
        throw new TypeError(`Unsupported type: function`)
      default:
        throw new TypeError(`Unknown type: ${meta.type}`)
    }
  }
  return args.map(metaToValue)
}

// Call a function and send reply asynchronously if it's a an asynchronous
// style function and the caller didn't pass a callback.
const callFunction = function (event, contextId, func, caller, args) {
  let err, funcMarkedAsync, funcName, funcPassedCallback, ref, ret
  funcMarkedAsync = v8Util.getHiddenValue(func, 'asynchronous')
  funcPassedCallback = typeof args[args.length - 1] === 'function'
  try {
    if (funcMarkedAsync && !funcPassedCallback) {
      args.push(function (ret) {
        event.returnValue = valueToMeta(event.sender, contextId, ret, true)
      })
      return func.apply(caller, args)
    } else {
      return func.apply(caller, args)
    }
  } catch (error) {
    // Catch functions thrown further down in function invocation and wrap
    // them with the function name so it's easier to trace things like
    // `Error processing argument -1.`
    funcName = ((ref = func.name) != null) ? ref : 'anonymous'
    err = new Error(`Could not call remote function '${funcName}'. Check that the function signature is correct. Underlying error: ${error.message}`)
    err.cause = error
    throw err
  }
}

const handleMember = function (target, prop) {
  if (typeof target[prop] === 'function') {
    return target[prop].bind(target)
  } else {
    return target[prop]
  }
}

const handleFunction = function (event, contextId, method, target, args) {
  args = unwrapArgs(event.sender, contextId, args)
  return callFunction(event, contextId, method, target, args)
}

const handleConstructor = function (event, contextId, constructor, args) {
  args = unwrapArgs(event.sender, contextId, args)
  // Call new with array of arguments.
  // http://stackoverflow.com/questions/1606797/use-of-apply-with-new-operator-is-this-possible
  return new (Function.prototype.bind.apply(constructor, [null].concat(args)))()
}

ipcMain.on('ELECTRON_BROWSER_LAZY_REMOTE_COMMIT', function (event, contextId, commands) {
  try {
    let ret, optimize = false
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i]
      switch (command.type) {
        case 'member_get':
          ret = handleMember(ret, command.name)
          break
        case 'member_set': {
          const value = unwrapArgs(event.sender, contextId, command.value)[0]
          ret[command.name] = value
          ret = null
          break
        }
        case 'member_call':
          ret = handleFunction(event, contextId, ret[command.name], ret, command.args)
          break
        case 'member_constructor': {
          const constructor = ret[command.name]
          ret = handleConstructor(event, contextId, constructor, command.args)
          break
        }

        case 'remote_object_get': {
          const obj = objectsRegistry.get(command.id)
          if (obj == null) {
            throwRPCError(`Cannot get property '${command.name}' on missing remote object ${command.id}`)
          }
          ret = handleMember(obj, command.name)
          break
        }
        case 'remote_object_set': {
          const obj = objectsRegistry.get(command.id)
          if (obj == null) {
            throwRPCError(`Cannot set property '${command.name}' on missing remote object ${command.id}`)
          }
          const value = unwrapArgs(event.sender, contextId, command.value)[0]
          obj[command.name] = value
          ret = null
          break
        }
        case 'remote_object_call': {
          const obj = objectsRegistry.get(command.id)
          if (obj == null) {
            throwRPCError(`Cannot call function '${command.name}' on missing remote object ${command.id}`)
          }
          ret = handleFunction(event, contextId, obj[command.name], obj, command.args)
          break
        }
        case 'remote_object_constructor': {
          const obj = objectsRegistry.get(command.id)
          if (obj == null) {
            throwRPCError(`Cannot call constructor '${command.name}' on missing remote object ${command.id}`)
          }
          const constructor = obj[command.name]
          ret = handleConstructor(event, contextId, constructor, command.args)
          break
        }

        case 'function_call': {
          let func
          if (command.id == null) {
            func = ret
          } else {
            func = objectsRegistry.get(command.id)
            if (func == null) {
              throwRPCError(`Cannot call function on missing remote object ${command.id}`)
            }
          }
          ret = handleFunction(event, contextId, func, global, command.args)
          break
        }
        case 'constructor_call': {
          let constructor
          if (command.id == null) {
            constructor = ret
          } else {
            constructor = objectsRegistry.get(command.id)
            if (constructor == null) {
              throwRPCError(`Cannot call constructor on missing remote object ${command.id}`)
            }
          }
          ret = handleConstructor(event, contextId, constructor, command.args)
          break
        }

        case 'get_builtin': {
          ret = electron[command.module]
          break
        }
        case 'get_global': {
          ret = global[command.name]
          break
        }
        case 'get_current_window': {
          ret = event.sender.getOwnerBrowserWindow()
          break
        }
        case 'get_current_web_contents': {
          ret = event.sender
          break
        }
        case 'require': {
          ret = process.mainModule.require(command.module)
          break
        }
      }
      if (command.type === 'function_call' || command.type === 'member_call') {
        optimize = true
      } else {
        optimize = false
      }
    }
    event.returnValue = valueToMeta(event.sender, contextId, ret, optimize)
  } catch (error) {
    event.returnValue = exceptionToMeta(event.sender, contextId, error)
  }
})

ipcMain.on('ELECTRON_BROWSER_LAZY_REMOTE_CONTEXT_RELEASE', (event, contextId) => {
  objectsRegistry.clear(event.sender, contextId)
  event.returnValue = null
})
