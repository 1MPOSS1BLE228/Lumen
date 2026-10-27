'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('live', {
  onTheme: (cb) => ipcRenderer.on('live:theme', (_e, t) => cb(t)),
  onPause: (cb) => ipcRenderer.on('live:pause', (_e, p) => cb(p)),
  onMode: (cb) => ipcRenderer.on('live:mode', (_e, m) => cb(m)),
  onImage: (cb) => ipcRenderer.on('live:image', (_e, buf) => cb(buf)),
  onData: (cb) => ipcRenderer.on('live:data', (_e, d) => cb(d)),
  onLang: (cb) => ipcRenderer.on('live:lang', (_e, l) => cb(l)),
  onPress: (cb) => ipcRenderer.on('live:press', (_e, id) => cb(id)),
  onHover: (cb) => ipcRenderer.on('live:hover', (_e, id) => cb(id)),
  setButtons: (b) => ipcRenderer.send('live:buttons', b),
});
