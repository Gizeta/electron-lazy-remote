const v8Util = process.atomBinding('v8_util')
const {ipcRenderer, isPromise} = require('electron')
const resolvePromise = Promise.resolve.bind(Promise)

const bufferUtils = require('../common/buffer-utils')

const remoteObjectCache = v8Util.createIDWeakMap()

// An unique ID that can represent current context.
const contextId = v8Util.getHiddenValue(global, 'contextId')

// Notify the main process when current context is going to be released.
// Note that when the renderer process is destroyed, the message may not be
// sent, we also listen to the "render-view-deleted" event in the main process
// to guard that situation.
process.on('exit', () => {
  const command = 'ELECTRON_BROWSER_LAZY_REMOTE_CONTEXT_RELEASE'
  ipcRenderer.sendSync(command, contextId)
})

// Convert the arguments object into an array of meta data.
function wrapArgs (args, visited = new Set()) {
  const valueToMeta = (value) => {
    // Check for circular reference.
    if (visited.has(value)) {
      return {
        type: 'value',
        value: null
      }
    }

    if (Array.isArray(value)) {
      visited.add(value)
      let meta = {
        type: 'array',
        value: wrapArgs(value, visited)
      }
      visited.delete(value)
      return meta
    } else if (bufferUtils.isBuffer(value)) {
      return {
        type: 'buffer',
        value: bufferUtils.bufferToMeta(value)
      }
    } else if (value instanceof Date) {
      return {
        type: 'date',
        value: value.getTime()
      }
    } else if ((value != null) && typeof value === 'object') {
      if (isPromise(value)) {
        return {
          type: 'promise',
          then: valueToMeta(function (onFulfilled, onRejected) {
            value.then(onFulfilled, onRejected)
          })
        }
      } else if (v8Util.getHiddenValue(value, 'atomId')) {
        return {
          type: 'remote-object',
          id: v8Util.getHiddenValue(value, 'atomId')
        }
      }

      let meta = {
        type: 'object',
        name: value.constructor ? value.constructor.name : '',
        members: []
      }
      visited.add(value)
      for (let prop in value) {
        meta.members.push({
          name: prop,
          value: valueToMeta(value[prop])
        })
      }
      visited.delete(value)
      return meta
    } else if (typeof value === 'function' && v8Util.getHiddenValue(value, 'returnValue')) {
      return {
        type: 'function-with-return-value',
        value: valueToMeta(value())
      }
    } else if (typeof value === 'function') {
      throw new TypeError(`Unsupported type: function`)
    } else {
      return {
        type: 'value',
        value: value
      }
    }
  }
  return args.map(valueToMeta)
}

// Populate object's members from descriptors.
// The |ref| will be kept referenced by |members|.
// This matches |getObjectMemebers| in rpc-server.
function setObjectMembers (ref, object, metaId, members) {
  if (!Array.isArray(members)) return

  for (let member of members) {
    if (object.hasOwnProperty(member.name)) continue

    let descriptor = { enumerable: member.enumerable }
    if (member.type === 'method') {
      descriptor.get = () => {
        return new LazyObject({ type: 'remote_object_get', id: metaId, name: member.name })
      }
    } else if (member.type === 'get') {
      descriptor.get = () => {
        return new LazyObject({ type: 'remote_object_get', id: metaId, name: member.name })
      }

      if (member.writable) {
        descriptor.set = (value) => {
          const args = wrapArgs([value])
          return new LazyObject({ type: 'remote_object_set', id: metaId, name: member.name, value: args }).$
        }
      }
    }

    Object.defineProperty(object, member.name, descriptor)
  }
}

// Populate object's prototype from descriptor.
// This matches |getObjectPrototype| in rpc-server.
function setObjectPrototype (ref, object, metaId, descriptor) {
  if (descriptor === null) return
  let proto = {}
  setObjectMembers(ref, proto, metaId, descriptor.members)
  setObjectPrototype(ref, proto, metaId, descriptor.proto)
  Object.setPrototypeOf(object, proto)
}

// Convert meta data from browser into real value.
function metaToValue (meta) {
  const types = {
    value: () => meta.value,
    array: () => meta.members.map((member) => metaToValue(member)),
    buffer: () => bufferUtils.metaToBuffer(meta.value),
    promise: () => resolvePromise({then: metaToValue(meta.then)}),
    error: () => metaToPlainObject(meta),
    date: () => new Date(meta.value),
    exception: () => { throw metaToException(meta) }
  }

  if (meta.type in types) {
    return types[meta.type]()
  } else {
    let ret
    if (remoteObjectCache.has(meta.id)) {
      return remoteObjectCache.get(meta.id)
    }

    // A shadow class to represent the remote function object.
    if (meta.type === 'function') {
      return new LazyObject({ type: 'function_call', id: meta.id })
    } else {
      ret = {}
    }

    setObjectMembers(ret, ret, meta.id, meta.members)
    setObjectPrototype(ret, ret, meta.id, meta.proto)
    Object.defineProperty(ret.constructor, 'name', { value: meta.name })

    // Track delegate obj's lifetime & tell browser to clean up when object is GCed.
    v8Util.setRemoteObjectFreer(ret, contextId, meta.id)
    v8Util.setHiddenValue(ret, 'atomId', meta.id)
    remoteObjectCache.set(meta.id, ret)
    return ret
  }
}

// Construct a plain object from the meta.
function metaToPlainObject (meta) {
  const obj = (() => meta.type === 'error' ? new Error() : {})()
  for (let i = 0; i < meta.members.length; i++) {
    let {name, value} = meta.members[i]
    obj[name] = value
  }
  return obj
}

// Construct an exception error from the meta.
function metaToException (meta) {
  const error = new Error(`${meta.message}\n${meta.stack}`)
  const remoteProcess = exports.process
  error.from = remoteProcess ? remoteProcess.type : null
  error.cause = metaToValue(meta.cause)
  return error
}

class LazyObject {
  constructor(cmd) {
    this.commands = [cmd]

    const _this = this
    const wrapper = new Proxy(new Function(), {
      get: function (_, prop) {
        if (prop === '$') {
          return _this.commit()
        }
        _this.commands.push({ type: 'member_get', name: prop })
        return wrapper
      },
      set: function (_, prop, value) {
        value = wrapArgs([value])
        _this.commands.push({ type: 'member_set', name: prop, value })
        return _this.commit()
      },
      apply: function (_, __, args) {
        const last = _this.commands[_this.commands.length - 1]
        args = wrapArgs(args)
        if (last.type === 'member_get') {
          last.args = args
          last.type = 'member_call'
        } else if (last.type === 'remote_object_get') {
          last.args = args
          last.type = 'remote_object_call'
        } else {
          _this.commands.push({ type: 'function_call', args })
        }
        return wrapper
      },
      construct: function(_, args) {
        const last = _this.commands[_this.commands.length - 1]
        args = wrapArgs(args)
        if (last.type === 'function_call') {
          last.args = args
          last.type = 'constructor_call'
        } else if (last.type === 'member_get') {
          last.args = args
          last.type = 'member_constructor'
        } else if (last.type === 'remote_object_get') {
          last.args = args
          last.type = 'remote_object_constructor'
        } else {
          _this.commands.push({ type: 'constructor_call', args })
        }
        return wrapper
      }
    })
    return wrapper
  }

  commit() {
    const meta = ipcRenderer.sendSync('ELECTRON_BROWSER_LAZY_REMOTE_COMMIT', contextId, this.commands)
    return metaToValue(meta)
  }
}

module.exports = LazyObject
