const isMainProcess = typeof process !== 'undefined' && process.type === 'browser';

if (isMainProcess) {
  require('./lib/browser/rpc-server')
} else {
  module.exports = require('./lib/renderer/remote')
}
