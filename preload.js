const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aria', {
  // Window
  minimize:   () => ipcRenderer.send('window-minimize'),
  maximize:   () => ipcRenderer.send('window-maximize'),
  close:      () => ipcRenderer.send('window-close'),
  showWindow: () => ipcRenderer.send('window-show'),

  // File system
  fsList: (dir) => ipcRenderer.invoke('fs-list', dir),
  fsOpen: (filePath) => ipcRenderer.invoke('fs-open', filePath),
  fsOpenFolder: (folderPath) => ipcRenderer.invoke('fs-open-folder', folderPath),
  fsCreateFile: (filePath, content) => ipcRenderer.invoke('fs-create-file', filePath, content),
  fsCreateFolder: (folderPath) => ipcRenderer.invoke('fs-create-folder', folderPath),
  fsRename: (oldPath, newName) => ipcRenderer.invoke('fs-rename', oldPath, newName),
  fsDelete: (filePath) => ipcRenderer.invoke('fs-delete', filePath),
  fsSearch: (query, dir) => ipcRenderer.invoke('fs-search', query, dir),
  fsCopy: (src, dest) => ipcRenderer.invoke('fs-copy', src, dest),
  fsRead: (filePath) => ipcRenderer.invoke('fs-read', filePath),
  fsWrite: (filePath, content) => ipcRenderer.invoke('fs-write', filePath, content),

  // Apps
  appLaunch: (appName) => ipcRenderer.invoke('app-launch', appName),
  appListRunning: () => ipcRenderer.invoke('app-list-running'),
  appKill: (appName) => ipcRenderer.invoke('app-kill', appName),

  // Browser
  browserSearch: (query, engine) => ipcRenderer.invoke('browser-search', query, engine),
  browserOpenUrl: (url) => ipcRenderer.invoke('browser-open-url', url),

  // System
  sysInfo: () => ipcRenderer.invoke('sys-info'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard-read'),
  sysScreenshot: () => ipcRenderer.invoke('sys-screenshot'),
  sysRunCommand: (cmd) => ipcRenderer.invoke('sys-run-command', cmd),
  sysOpenSettings: (setting) => ipcRenderer.invoke('sys-open-settings', setting),

  // Claude AI
  aiMessage: (apiKey, messages, systemPrompt) => ipcRenderer.invoke('ai-message', apiKey, messages, systemPrompt),
  geminiMessage: (apiKey, messages, systemPrompt) => ipcRenderer.invoke('gemini-message', apiKey, messages, systemPrompt),

  // Ollama AI
  ollamaStatus:  (host)             => ipcRenderer.invoke('ollama-status', host),
  ollamaPull:    (model, host)      => ipcRenderer.invoke('ollama-pull', model, host),
  ollamaPrewarm: (model, host)      => ipcRenderer.invoke('ollama-prewarm', model, host),
  ollamaChat:    (model, messages, systemPrompt, host) => ipcRenderer.invoke('ollama-chat', model, messages, systemPrompt, host),
  onStreamToken: (cb) => ipcRenderer.on('aria-stream-token', (_, t) => cb(t)),
  onStreamDone:  (cb) => ipcRenderer.on('aria-stream-done',  (_, f) => cb(f)),
  onStreamError: (cb) => ipcRenderer.on('aria-stream-error', (_, e) => cb(e)),
  removeStreamListeners: () => {
    ipcRenderer.removeAllListeners('aria-stream-token');
    ipcRenderer.removeAllListeners('aria-stream-done');
    ipcRenderer.removeAllListeners('aria-stream-error');
  },

  // Whisper local STT
  whisperStatus:     ()      => ipcRenderer.invoke('whisper-status'),
  whisperSetup:      ()      => ipcRenderer.invoke('whisper-setup'),
  whisperTranscribe: (buf)   => ipcRenderer.invoke('whisper-transcribe', buf),
  onWhisperProgress: (cb)    => ipcRenderer.on('whisper-setup-progress', (_, d) => cb(d)),
  offWhisperProgress:()      => ipcRenderer.removeAllListeners('whisper-setup-progress'),

  // Window visibility events (for hotword listener)
  onWindowHide: (cb) => ipcRenderer.on('window-hidden', cb),
  onWindowShow: (cb) => ipcRenderer.on('window-shown',  cb),

  // Config
  storeApiKey: (key) => ipcRenderer.invoke('store-api-key', key),
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  saveConfig: (updates) => ipcRenderer.invoke('save-config', updates),
  loadConfig: () => ipcRenderer.invoke('load-config'),

  // Command Memory
  memoryLoad: () => ipcRenderer.invoke('memory-load'),
  memorySaveEntry: (entry) => ipcRenderer.invoke('memory-save-entry', entry),
  memoryDeleteEntry: (id) => ipcRenderer.invoke('memory-delete-entry', id),
  memoryClear: () => ipcRenderer.invoke('memory-clear'),
});
