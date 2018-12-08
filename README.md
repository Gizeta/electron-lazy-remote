electron-lazy-remote
===

Example
---
```js
const remote = require('electrom-lazy-remote')

console.log(remote.getCurrentWindow().id.$)

const newWindow = new remote.BrowserWindow().$
newWindow.hide().$
remote.app.foo = { a: 1, b: "2" }
console.log(remote.app.foo.a.$)
console.log(remote.app.foo.$.b.$)
```

Attention
---
* MUST require the package in the main process before using
* use `xxx.$` to make IPC calls
* CANNOT pass function type in arguments
