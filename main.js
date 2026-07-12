const { app, BrowserWindow, ipcMain, shell, clipboard, globalShortcut, Tray, Menu, nativeImage, dialog, screen, desktopCapturer, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn, execSync } = require('child_process');
const https = require('https');
const http = require('http');

let mainWindow;
let tray;

// ─── Window Creation ────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    frame: false,
    transparent: false,
    backgroundColor: '#050810',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
    titleBarStyle: 'hidden',
  });

  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('hide',   () => mainWindow?.webContents.send('window-hidden'));
  mainWindow.on('show',   () => mainWindow?.webContents.send('window-shown'));
  mainWindow.on('focus',  () => mainWindow?.webContents.send('window-shown'));
}

// ─── Tray ────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  if (fs.existsSync(iconPath)) {
    tray = new Tray(iconPath);
  } else {
    const img = nativeImage.createEmpty();
    tray = new Tray(img);
  }
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show ARIA', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setToolTip('ARIA Assistant');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Grant microphone permission for voice input
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') return callback(true);
    callback(false);
  });

  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus());
    }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => globalShortcut.unregisterAll());

// ─── IPC Handlers ────────────────────────────────────────────────────

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.hide());
ipcMain.on('window-show',  () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// ─── FILE OPERATIONS ─────────────────────────────────────────────────

ipcMain.handle('fs-list', async (_, dirPath) => {
  try {
    const resolved = resolvePath(dirPath);
    const items = fs.readdirSync(resolved, { withFileTypes: true });
    return {
      ok: true,
      path: resolved,
      items: items.map(i => ({
        name: i.name,
        isDir: i.isDirectory(),
        path: path.join(resolved, i.name),
        ext: path.extname(i.name).toLowerCase()
      }))
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs-open', async (_, filePath) => {
  try {
    const resolved = resolvePath(filePath);
    if (!fs.existsSync(resolved)) return { ok: false, error: `File not found: ${resolved}` };
    await shell.openPath(resolved);
    return { ok: true, message: `Opened: ${resolved}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs-open-folder', async (_, folderPath) => {
  try {
    const resolved = resolvePath(folderPath);
    await shell.openPath(resolved);
    return { ok: true, message: `Opened folder: ${resolved}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs-create-file', async (_, filePath, content) => {
  try {
    const resolved = resolvePath(filePath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(resolved)) return { ok: false, error: `File already exists: ${resolved}` };
    fs.writeFileSync(resolved, content || '', 'utf8');
    return { ok: true, message: `Created: ${resolved}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs-create-folder', async (_, folderPath) => {
  try {
    const resolved = resolvePath(folderPath);
    if (fs.existsSync(resolved)) return { ok: false, error: `Folder already exists: ${resolved}` };
    fs.mkdirSync(resolved, { recursive: true });
    return { ok: true, message: `Created folder: ${resolved}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs-rename', async (_, oldPath, newName) => {
  try {
    const resolvedOld = resolvePath(oldPath);
    if (!fs.existsSync(resolvedOld)) return { ok: false, error: `Not found: ${resolvedOld}` };
    const dir = path.dirname(resolvedOld);
    const newPath = path.join(dir, newName);
    if (fs.existsSync(newPath)) return { ok: false, error: `A file named "${newName}" already exists` };
    fs.renameSync(resolvedOld, newPath);
    return { ok: true, message: `Renamed to: ${newPath}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs-delete', async (_, filePath) => {
  try {
    const resolved = resolvePath(filePath);
    if (!fs.existsSync(resolved)) return { ok: false, error: `Not found: ${resolved}` };
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning', buttons: ['Move to Trash', 'Cancel'],
      message: `Delete "${path.basename(resolved)}"?`,
      detail: resolved
    });
    if (response === 1) return { ok: false, error: 'Cancelled by user' };
    await shell.trashItem(resolved);
    return { ok: true, message: `Moved to trash: ${resolved}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs-search', async (_, query, searchDir) => {
  try {
    const dir = resolvePath(searchDir || os.homedir());
    const results = [];
    searchRecursive(dir, query.toLowerCase(), results, 0, 3);
    return { ok: true, results: results.slice(0, 20) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs-copy', async (_, src, dest) => {
  try {
    const resolvedSrc = resolvePath(src);
    const resolvedDest = resolvePath(dest);
    if (!fs.existsSync(resolvedSrc)) return { ok: false, error: `Source not found: ${resolvedSrc}` };
    fs.copyFileSync(resolvedSrc, resolvedDest);
    return { ok: true, message: `Copied to: ${resolvedDest}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs-read', async (_, filePath) => {
  try {
    const resolved = resolvePath(filePath);
    if (!fs.existsSync(resolved)) return { ok: false, error: `Not found: ${resolved}` };
    const stat = fs.statSync(resolved);
    if (stat.size > 1024 * 1024) return { ok: false, error: 'File too large to read (>1MB)' };
    const content = fs.readFileSync(resolved, 'utf8');
    return { ok: true, content };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs-write', async (_, filePath, content) => {
  try {
    const resolved = resolvePath(filePath);
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true, message: `Saved: ${resolved}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── APP OPERATIONS ───────────────────────────────────────────────────

ipcMain.handle('app-launch', async (_, appName) => {
  try {
    const cmd = getLaunchCommand(appName);
    exec(cmd, { shell: true }, (err) => {
      if (err) console.log('Launch note:', err.message);
    });
    return { ok: true, message: `Launching: ${appName}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('app-list-running', async () => {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' });
    const procs = out.split('\n')
      .filter(l => l.trim())
      .map(l => { const p = l.split(','); return p[0]?.replace(/"/g, '').trim(); })
      .filter(Boolean);
    const unique = [...new Set(procs)].slice(0, 30);
    return { ok: true, processes: unique };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('app-kill', async (_, appName) => {
  try {
    // Sanitize — strip anything that isn't alphanumeric, dots, dashes, underscores
    const safe = appName.replace(/[^a-zA-Z0-9.\-_]/g, '');
    // Ensure .exe suffix for taskkill
    const exe = safe.toLowerCase().endsWith('.exe') ? safe : `${safe}.exe`;
    execSync(`taskkill /IM "${exe}" /F`, { encoding: 'utf8' });
    return { ok: true, message: `Killed: ${exe}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── BROWSER / WEB ────────────────────────────────────────────────────

ipcMain.handle('browser-search', async (_, query, engine) => {
  try {
    const engines = {
      google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      github: `https://github.com/search?q=${encodeURIComponent(query)}`,
    };
    const url = engines[engine?.toLowerCase()] || engines.google;
    await shell.openExternal(url);
    return { ok: true, message: `Searching for "${query}" on ${engine || 'Google'}`, url };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('browser-open-url', async (_, url) => {
  try {
    const full = url.startsWith('http') ? url : `https://${url}`;
    await shell.openExternal(full);
    return { ok: true, message: `Opened: ${full}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── SYSTEM OPERATIONS ────────────────────────────────────────────────

ipcMain.handle('sys-info', async () => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    return {
      ok: true,
      info: {
        platform: os.platform(),
        hostname: os.hostname(),
        username: os.userInfo().username,
        homedir: os.homedir(),
        desktop: path.join(os.homedir(), 'Desktop'),
        downloads: path.join(os.homedir(), 'Downloads'),
        documents: path.join(os.homedir(), 'Documents'),
        cpu: os.cpus()[0]?.model || 'Unknown',
        cpuCores: os.cpus().length,
        totalMemGB: (totalMem / 1024 / 1024 / 1024).toFixed(1),
        usedMemGB: (usedMem / 1024 / 1024 / 1024).toFixed(1),
        freeMemGB: (freeMem / 1024 / 1024 / 1024).toFixed(1),
        uptime: formatUptime(os.uptime()),
        arch: os.arch(),
        osVersion: os.version?.() || os.release(),
      }
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('clipboard-write', async (_, text) => {
  try {
    clipboard.writeText(text);
    return { ok: true, message: `Copied to clipboard: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"` };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('clipboard-read', async () => {
  try {
    const text = clipboard.readText();
    return { ok: true, content: text };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('sys-screenshot', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: 1920, height: 1080 }
    });
    if (!sources.length) return { ok: false, error: 'No screen sources found' };
    const img = sources[0].thumbnail.toPNG();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(os.homedir(), 'Pictures');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const savePath = path.join(dir, `screenshot-${ts}.png`);
    fs.writeFileSync(savePath, img);
    return { ok: true, message: `Screenshot saved: ${savePath}`, path: savePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('sys-run-command', async (_, cmd) => {
  try {
    const output = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
    return { ok: true, output };
  } catch (e) { return { ok: false, error: e.message, output: e.stdout }; }
});

ipcMain.handle('sys-open-settings', async (_, setting) => {
  try {
    const settingsMap = {
      display: 'ms-settings:display',
      wifi: 'ms-settings:network-wifi',
      bluetooth: 'ms-settings:bluetooth',
      sound: 'ms-settings:sound',
      apps: 'ms-settings:appsfeatures',
      default: 'ms-settings:'
    };
    const url = settingsMap[setting?.toLowerCase()] || settingsMap.default;
    await shell.openExternal(url);
    return { ok: true, message: `Opened Windows Settings: ${setting || 'main'}` };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── CONFIG HELPERS ───────────────────────────────────────────────────

function getConfigPath() { return path.join(app.getPath('userData'), 'config.json'); }

function loadConfig() {
  try {
    const p = getConfigPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return {}; }
}

function saveConfig(updates) {
  try {
    const p = getConfigPath();
    const config = loadConfig();
    Object.assign(config, updates);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
    return true;
  } catch { return false; }
}

ipcMain.handle('store-api-key', async (_, key) => {
  return saveConfig({ apiKey: key }) ? { ok: true } : { ok: false, error: 'Failed to save' };
});

ipcMain.handle('get-api-key', async () => {
  const config = loadConfig();
  return { ok: true, key: config.apiKey || null };
});

ipcMain.handle('save-config', async (_, updates) => {
  return saveConfig(updates) ? { ok: true } : { ok: false, error: 'Failed to save' };
});

ipcMain.handle('load-config', async () => {
  return { ok: true, config: loadConfig() };
});

// ─── COMMAND MEMORY ───────────────────────────────────────────────────

function getMemoryPath() { return path.join(app.getPath('userData'), 'memory.json'); }

function loadMemory() {
  try {
    const p = getMemoryPath();
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
}

function saveMemory(entries) {
  try {
    fs.writeFileSync(getMemoryPath(), JSON.stringify(entries, null, 2));
    return true;
  } catch { return false; }
}

ipcMain.handle('memory-load', async () => {
  return { ok: true, entries: loadMemory() };
});

ipcMain.handle('memory-save-entry', async (_, entry) => {
  // entry = { id, phrase, action, label, useCount, lastUsed }
  const entries = loadMemory();
  const existing = entries.findIndex(e => e.id === entry.id);
  if (existing >= 0) entries[existing] = entry;
  else entries.unshift(entry);
  // Keep max 200 entries, sorted by useCount desc
  entries.sort((a, b) => (b.useCount || 0) - (a.useCount || 0));
  const trimmed = entries.slice(0, 200);
  return saveMemory(trimmed) ? { ok: true } : { ok: false, error: 'Failed to save' };
});

ipcMain.handle('memory-delete-entry', async (_, id) => {
  const entries = loadMemory().filter(e => e.id !== id);
  return saveMemory(entries) ? { ok: true } : { ok: false, error: 'Failed to delete' };
});

ipcMain.handle('memory-clear', async () => {
  return saveMemory([]) ? { ok: true } : { ok: false, error: 'Failed to clear' };
});

// ─── OLLAMA INTEGRATION ───────────────────────────────────────────────

ipcMain.handle('ollama-status', async (_, host) => {
  return new Promise((resolve) => {
    const baseUrl = (host || 'http://localhost:11434').replace(/\/$/, '');
    let parsedUrl;
    try { parsedUrl = new URL(`${baseUrl}/api/tags`); }
    catch (e) { return resolve({ ok: false, running: false, error: `Invalid host URL: ${baseUrl} — ${e.message}` }); }

    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port = parsedUrl.port
      ? parseInt(parsedUrl.port)
      : (isHttps ? 443 : 80);

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port,
      path: '/api/tags',
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 6000,
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return resolve({ ok: false, running: false, error: `Ollama returned HTTP ${res.statusCode}. Raw: ${data.substring(0,200)}` });
          }
          const parsed = JSON.parse(data);
          const models = (parsed.models || []).map(m => ({
            name: m.name,
            size: m.size || 0,
            modified: m.modified_at || '',
            family: m.details?.family || '',
            paramSize: m.details?.parameter_size || '',
          }));
          resolve({ ok: true, models, running: true });
        } catch (e) {
          resolve({ ok: false, running: false, error: `Failed to parse Ollama response: ${e.message}. Raw: ${data.substring(0,100)}` });
        }
      });
    });

    req.on('error', (e) => {
      let msg;
      if (e.code === 'ECONNREFUSED') msg = `Connection refused at ${baseUrl} — make sure Ollama is running (run: ollama serve)`;
      else if (e.code === 'ENOTFOUND') msg = `Host not found: ${parsedUrl.hostname}`;
      else if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT') msg = 'Connection timed out — Ollama may be starting up, try again';
      else msg = `${e.code || 'Network error'}: ${e.message}`;
      resolve({ ok: false, running: false, error: msg });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, running: false, error: `Timed out connecting to ${baseUrl} — check if Ollama is running` });
    });

    req.end();
  });
});

// Pull a model via Ollama
ipcMain.handle('ollama-pull', async (_, modelName, host) => {
  return new Promise((resolve) => {
    const baseUrl = (host || 'http://localhost:11434').replace(/\/$/, '');
    const body = JSON.stringify({ name: modelName, stream: false });
    let parsedUrl;
    try { parsedUrl = new URL(`${baseUrl}/api/pull`); }
    catch (e) { return resolve({ ok: false, error: `Invalid host: ${e.message}` }); }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const port = parsedUrl.port ? parseInt(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80);
    const options = {
      hostname: parsedUrl.hostname, port,
      path: parsedUrl.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 600000,
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const lines = data.trim().split('\n').filter(Boolean);
          const last = JSON.parse(lines[lines.length - 1]);
          if (last.status === 'success') resolve({ ok: true, message: `${modelName} pulled successfully` });
          else resolve({ ok: true, message: last.status || 'Pull completed' });
        } catch { resolve({ ok: true, message: 'Pull completed' }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
});

// ── Ollama pre-warm — loads model into VRAM silently, fire-and-forget ────────
ipcMain.handle('ollama-prewarm', async (_, modelName, host) => {
  if (!modelName) return { ok: false, error: 'No model specified' };
  const baseUrl = (host || 'http://localhost:11434').replace(/\/$/, '');
  const body = JSON.stringify({
    model: modelName,
    stream: false,
    keep_alive: -1,
    messages: [{ role: 'user', content: '.' }],
    options: { num_predict: 1, temperature: 0 },
  });
  try {
    const parsedUrl = new URL(`${baseUrl}/api/chat`);
    const lib  = parsedUrl.protocol === 'https:' ? https : http;
    const port = parsedUrl.port ? parseInt(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80);
    await new Promise((resolve) => {
      const req = lib.request({
        hostname: parsedUrl.hostname, port,
        path: '/api/chat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 60000,
      }, (res) => {
        res.resume(); // drain and discard — we only care that the model loaded
        res.on('end', resolve);
      });
      req.on('error', resolve); // ignore errors — this is best-effort
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    });
    console.log(`[ARIA] pre-warmed ${modelName}`);
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// ── Ollama chat — streams tokens to renderer, resolves when done ──────────
ipcMain.handle('ollama-chat', async (_, modelName, messages, systemPrompt, host) => {
  const baseUrl = (host || 'http://localhost:11434').replace(/\/$/, '');
  const payload = {
    model: modelName,
    stream: true,
    keep_alive: -1,   // keep model loaded in VRAM permanently — eliminates cold-load delay
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    options: { temperature: 0.1, num_predict: 80 }
  };
  const bodyStr = JSON.stringify(payload);

  return new Promise((resolve) => {
    let parsedUrl;
    try { parsedUrl = new URL(`${baseUrl}/api/chat`); }
    catch (e) { return resolve({ ok: false, error: `Bad URL: ${e.message}` }); }

    const port = parsedUrl.port ? parseInt(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80);
    const lib  = parsedUrl.protocol === 'https:' ? https : http;

    let fullText = '';
    let buffer   = '';
    let done     = false;
    let hardTimer;

    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      if (err) {
        console.error('[ARIA] stream error:', err);
        mainWindow?.webContents.send('aria-stream-error', String(err));
        resolve({ ok: false, error: String(err) });
      } else {
        console.log(`[ARIA] stream done (${fullText.length} chars)`);
        mainWindow?.webContents.send('aria-stream-done', fullText);
        resolve({ ok: true, text: fullText, streamed: true });
      }
    }

    hardTimer = setTimeout(() => {
      req.destroy();
      finish('No response after 45s — model may be loading, try again');
    }, 45000);

    const req = lib.request({
      hostname: parsedUrl.hostname, port,
      path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: 45000,
    }, (res) => {
      if (res.statusCode !== 200) {
        let e = ''; res.on('data', c => e += c);
        res.on('end', () => finish(`Ollama HTTP ${res.statusCode}: ${e.substring(0, 150)}`));
        return;
      }

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // last line may be incomplete

        let batchedTokens = '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj.error) { finish(obj.error); return; }
            const token = obj.message?.content || '';
            if (token && !done) {
              fullText += token;
              batchedTokens += token;
            }
          } catch (_) { /* incomplete JSON — wait for next chunk */ }
        }
        // Send all tokens from this chunk in one IPC call instead of one per token
        if (batchedTokens && !done) {
          mainWindow?.webContents.send('aria-stream-token', batchedTokens);
        }
      });

      res.on('end', () => {
        // Flush remaining buffer
        if (buffer.trim()) {
          try {
            const obj = JSON.parse(buffer.trim());
            const token = obj.message?.content || '';
            if (token && !done) { fullText += token; mainWindow?.webContents.send('aria-stream-token', token); }
          } catch (_) {}
        }
        finish(null);
      });

      res.on('error', e => finish(e.message));
    });

    req.on('error', e => {
      const msg = e.code === 'ECONNREFUSED'
        ? 'Connection refused — is Ollama running? Run: ollama serve'
        : `${e.code}: ${e.message}`;
      finish(msg);
    });
    req.on('timeout', () => { req.destroy(); finish('Socket timed out'); });
    req.write(bodyStr);
    req.end();
  });
});

ipcMain.handle('ai-message', async (_, apiKey, messages, systemPrompt) => {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });

    let resolved = false;
    const hardTimer = setTimeout(() => {
      if (!resolved) { resolved = true; req.destroy(); resolve({ ok: false, error: 'Claude API timed out after 60s' }); }
    }, 60000);

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (resolved) return;
        resolved = true; clearTimeout(hardTimer);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) resolve({ ok: false, error: parsed.error.message || JSON.stringify(parsed.error) });
          else resolve({ ok: true, content: parsed.content });
        } catch (e) { resolve({ ok: false, error: `Parse error: ${e.message}` }); }
      });
    });
    req.on('error', e => { if (!resolved) { resolved = true; clearTimeout(hardTimer); resolve({ ok: false, error: e.message }); } });
    req.on('timeout', () => { req.destroy(); if (!resolved) { resolved = true; clearTimeout(hardTimer); resolve({ ok: false, error: 'Claude API request timed out' }); } });
    req.write(body);
    req.end();
  });
});

ipcMain.handle('gemini-message', async (_, apiKey, messages, systemPrompt) => {
  return new Promise((resolve) => {
    // Gemini uses 'user'/'model' roles and a 'contents' array, not 'messages'
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const body = JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
    });

    const model = 'gemini-2.5-flash'; // fast + free-tier friendly
    let resolved = false;
    const hardTimer = setTimeout(() => {
      if (!resolved) { resolved = true; req.destroy(); resolve({ ok: false, error: 'Gemini API timed out after 30s' }); }
    }, 30000);

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (resolved) return;
        resolved = true; clearTimeout(hardTimer);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return resolve({ ok: false, error: parsed.error.message || JSON.stringify(parsed.error) });
          const text = parsed.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
          resolve({ ok: true, text });
        } catch (e) { resolve({ ok: false, error: `Parse error: ${e.message}` }); }
      });
    });
    req.on('error', e => { if (!resolved) { resolved = true; clearTimeout(hardTimer); resolve({ ok: false, error: e.message }); } });
    req.on('timeout', () => { req.destroy(); if (!resolved) { resolved = true; clearTimeout(hardTimer); resolve({ ok: false, error: 'Gemini API request timed out' }); } });
    req.write(body);
    req.end();
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────

function resolvePath(p) {
  if (!p) return os.homedir();
  p = p.trim();
  if (p.startsWith('~')) return p.replace('~', os.homedir());
  const shortcuts = {
    'desktop': path.join(os.homedir(), 'Desktop'),
    'downloads': path.join(os.homedir(), 'Downloads'),
    'documents': path.join(os.homedir(), 'Documents'),
    'pictures': path.join(os.homedir(), 'Pictures'),
    'music': path.join(os.homedir(), 'Music'),
    'videos': path.join(os.homedir(), 'Videos'),
    'home': os.homedir(),
  };
  const lower = p.toLowerCase();
  if (shortcuts[lower]) return shortcuts[lower];
  if (!path.isAbsolute(p)) return path.join(os.homedir(), p);
  return p;
}

function searchRecursive(dir, query, results, depth, maxDepth) {
  if (depth > maxDepth) return;
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (item.name.toLowerCase().includes(query)) {
        results.push({
          name: item.name,
          path: path.join(dir, item.name),
          isDir: item.isDirectory()
        });
      }
      if (item.isDirectory() && !['node_modules', 'AppData', '$Recycle.Bin', 'Windows'].includes(item.name)) {
        searchRecursive(path.join(dir, item.name), query, results, depth + 1, maxDepth);
      }
    }
  } catch (_) {}
}

function getLaunchCommand(appName) {
  const apps = {
    'chrome': 'start chrome',
    'google chrome': 'start chrome',
    'firefox': 'start firefox',
    'edge': 'start msedge',
    'notepad': 'start notepad',
    'calculator': 'start calc',
    'paint': 'start mspaint',
    'word': 'start winword',
    'excel': 'start excel',
    'powerpoint': 'start powerpnt',
    'explorer': 'start explorer',
    'file explorer': 'start explorer',
    'cmd': 'start cmd',
    'terminal': 'start wt',
    'powershell': 'start powershell',
    'task manager': 'start taskmgr',
    'control panel': 'start control',
    'spotify': 'start spotify',
    'discord': 'start discord',
    'steam': 'start steam',
    'vlc': 'start vlc',
    'vscode': 'start code',
    'vs code': 'start code',
    'visual studio code': 'start code',
    'zoom': 'start zoom',
    'slack': 'start slack',
    'teams': 'start teams',
  };
  const key = appName.toLowerCase().trim();
  return apps[key] || `start ${appName}`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── WHISPER LOCAL STT ────────────────────────────────────────────────────────

const WHISPER_DIR   = path.join(app.getPath('userData'), 'whisper');
const WHISPER_CLI   = path.join(WHISPER_DIR, 'whisper-cli.exe');
const WHISPER_MODEL = path.join(WHISPER_DIR, 'ggml-base.en.bin');
const WHISPER_ZIP_URL  = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip';
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

function whisperReady() {
  return fs.existsSync(WHISPER_CLI) && fs.existsSync(WHISPER_MODEL);
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const mod = url.startsWith('https') ? https : http;

    const followRedirect = (u) => {
      const parsedUrl = new URL(u);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { 'User-Agent': 'ARIA-Assistant' }
      };
      mod.get(options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          followRedirect(res.headers.location); return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`HTTP ${res.statusCode} from ${u}`)); return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', chunk => {
          received += chunk.length;
          if (total && onProgress) onProgress(Math.round(received / total * 100));
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', (err) => { file.close(); reject(err); });
      }).on('error', (err) => { file.close(); reject(err); });
    };

    followRedirect(url);
  });
}

function unzipWhisper(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    // Use PowerShell's built-in Expand-Archive — works on all Win10/11
    const cmd = `powershell -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'"`;
    exec(cmd, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

async function setupWhisper(event) {
  const send = (msg, pct) => {
    try { event.sender.send('whisper-setup-progress', { msg, pct }); } catch(_) {}
  };

  if (whisperReady()) { send('Ready', 100); return { ok: true }; }

  try {
    fs.mkdirSync(WHISPER_DIR, { recursive: true });

    // 1. Download whisper-bin-x64.zip if cli not present
    if (!fs.existsSync(WHISPER_CLI)) {
      send('Downloading whisper-cli.exe…', 5);
      const zipPath = path.join(WHISPER_DIR, 'whisper-bin-x64.zip');
      await downloadFile(WHISPER_ZIP_URL, zipPath, pct => send(`Downloading whisper-cli… ${pct}%`, Math.round(pct * 0.5)));
      send('Extracting…', 52);
      await unzipWhisper(zipPath, WHISPER_DIR);
      // The zip extracts into a subfolder — find whisper-cli.exe recursively
      const findCli = (dir) => {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (fs.statSync(full).isDirectory()) { const r = findCli(full); if (r) return r; }
          else if (f === 'whisper-cli.exe') return full;
        }
        return null;
      };
      const found = findCli(WHISPER_DIR);
      if (!found) throw new Error('whisper-cli.exe not found in zip — try downloading manually');
      // Copy exe to WHISPER_DIR root if it's nested in a subfolder
      if (found !== WHISPER_CLI) fs.copyFileSync(found, WHISPER_CLI);
      // Copy required DLLs from the same folder as the exe
      const dllDir = path.dirname(found);
      if (dllDir !== WHISPER_DIR) {
        for (const f of fs.readdirSync(dllDir)) {
          if (f.endsWith('.dll') || f.endsWith('.ggml')) {
            const src = path.join(dllDir, f);
            const dst = path.join(WHISPER_DIR, f);
            if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
          }
        }
      }
      // Zip cleanup last — after everything is safely copied
      try { fs.unlinkSync(zipPath); } catch(_) {}
      send('whisper-cli.exe ready', 55);
    }

    // 2. Download model if not present
    if (!fs.existsSync(WHISPER_MODEL)) {
      send('Downloading ggml-base.en model (~150 MB)…', 57);
      await downloadFile(WHISPER_MODEL_URL, WHISPER_MODEL, pct => send(`Downloading model… ${pct}%`, 57 + Math.round(pct * 0.43)));
      send('Model ready', 100);
    }

    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('whisper-setup', async (event) => {
  return await setupWhisper(event);
});

ipcMain.handle('whisper-status', async () => {
  return { ok: true, ready: whisperReady(), dir: WHISPER_DIR };
});

ipcMain.handle('whisper-transcribe', async (event, audioBuffer) => {
  if (!whisperReady()) return { ok: false, error: 'Whisper not set up. Click the mic and run setup first.' };

  // MediaRecorder outputs WebM/Opus — whisper-cli accepts it directly
  const tmpFile = path.join(WHISPER_DIR, `rec_${Date.now()}.webm`);
  const tmpBuf  = Buffer.from(audioBuffer);

  try {
    fs.writeFileSync(tmpFile, tmpBuf);

    const transcript = await new Promise((resolve, reject) => {
      const args = ['-m', WHISPER_MODEL, '-f', tmpFile, '-l', 'en', '-nt', '--no-prints'];
      const proc = spawn(WHISPER_CLI, args, { cwd: WHISPER_DIR });

      let out = '', err = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => err += d.toString());
      proc.on('close', code => {
        if (code !== 0 && !out.trim()) reject(new Error(err.trim() || `whisper-cli exited with code ${code}`));
        else resolve(out.trim() || err.trim());
      });
      proc.on('error', reject);
      // 30s hard timeout
      const timer = setTimeout(() => { try { proc.kill(); } catch(_) {} reject(new Error('Whisper timed out')); }, 30000);
      proc.on('close', () => clearTimeout(timer));
    });

    const clean = transcript
      .replace(/\[.*?\]/g, '')   // [BLANK_AUDIO], [Music], etc.
      .replace(/\(.*?\)/g, '')   // (silence), etc.
      .replace(/\s+/g, ' ')
      .trim();

    return { ok: true, text: clean };
  } catch(e) {
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch(_) {}
  }
});
