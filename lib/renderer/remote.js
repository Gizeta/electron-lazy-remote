const LazyObject = require('./lazy-object')

exports.require = (module) => {
  return new LazyObject({ type: 'require', module })
}

// Alias to remote.require('electron').xxx.
exports.getBuiltin = (module) => {
  return new LazyObject({ type: 'get_builtin', module })
}

exports.getCurrentWindow = () => {
  return new LazyObject({ type: 'get_current_window' })
}

// Get current WebContents object.
exports.getCurrentWebContents = () => {
  return new LazyObject({ type: 'get_current_web_contents' })
}

// Get a global object in browser.
exports.getGlobal = (name) => {
  return new LazyObject({ type: 'get_global', name })
}

// Get the process object in browser.
exports.__defineGetter__('process', () => exports.getGlobal('process'))

const addBuiltinProperty = (name) => {
  Object.defineProperty(exports, name, {
    get: () => exports.getBuiltin(name)
  })
}

const browserModules =
  require('../common/module-list').concat(
  require('../browser/module-list'))

// And add a helper receiver for each one.
browserModules
  .filter((m) => !m.private)
  .map((m) => m.name)
  .forEach(addBuiltinProperty)
