import { useState, useCallback, useRef, useEffect } from 'react';

// ── Markdown-lite formatter (safe HTML) ──────────────────────────
export function fmt(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--cyan)">$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
}

export function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function stripJson(text) {
  return text
    .replace(/```json[\s\S]*?```/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
}

// ── System prompt builder ────────────────────────────────────────
function buildPrompt(sysInfo) {
  const D = sysInfo?.desktop   || 'C:/Users/user/Desktop';
  const L = sysInfo?.downloads || 'C:/Users/user/Downloads';
  const U = sysInfo?.username  || 'user';

  // Compact prompt — every token saved = faster first response
  return `ARIA: Windows assistant for ${U}. Desktop="${D}" Downloads="${L}"
Reply: one sentence + JSON.
Example: Opening Chrome.\`\`\`json\n{"action":"launch_app","name":"chrome"}\`\`\`
Actions: launch_app(name) web_search(query,engine) open_url(url) open_file(path) open_folder(path) list_files(path) search_files(query,dir) create_file(path,content) create_folder(path) rename(pat[...]
Apps: chrome firefox edge notepad calculator vlc spotify discord zoom vscode word excel cmd powershell explorer
Vague: bored→web_search youtube | music→launch spotify | write→launch notepad | code→launch vscode | chat→launch discord | screenshot→screenshot | stats→sys_info
Rule: always output JSON. One sentence only.`;
}

// ── Message shape ────────────────────────────────────────────────
// { id, role: 'user'|'ai', text, result, model, elapsed, isStreaming }

function nowStr() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

let _msgId = 0;
const nextId = () => ++_msgId;

// ── Hook ─────────────────────────────────────────────────────────
export function useChat({
  ollamaRunning, ollamaModel, ollamaHost,
  claudeApiKey, aiMode, sysInfo,
  parseAndRun, runAction,
  memoryExactMatch, memoryFuzzyMatch, memorySave,
  showToast,
}) {

  const [messages,     setMessages]     = useState([]);
  const [history,      setHistory]      = useState([]);
  const [isLoading,    setIsLoading]    = useState(false);
  const [fuzzyPending, setFuzzyPending] = useState(null);

  // Cache the system prompt — rebuild only when sysInfo changes
  const promptRef = useRef('');
  useEffect(() => {
    promptRef.current = buildPrompt(sysInfo);
  }, [sysInfo]);

  // ── Welcome message ───────────────────────────────────────────
  const showWelcome = useCallback((model) => {
    const u = sysInfo?.username;
    const text = `Hello${u ? ` **${u}**` : ''}! I'm ARIA, powered by **${model}**.\n\nTry: *"open Chrome"*, *"show my Downloads"*, *"I'm bored"*, *"take a screenshot"*`;
    setMessages([{ id: nextId(), role: 'ai', text, model, timestamp: nowStr() }]);
  }, [sysInfo]);

  // ── Add message helpers ───────────────────────────────────────
  const addUserMsg  = useCallback((text) =>
    setMessages(prev => [...prev, { id: nextId(), role: 'user', text, timestamp: nowStr() }]), []);

  const addAiMsg = useCallback((text, result, model, elapsed) =>
    setMessages(prev => [...prev, { id: nextId(), role: 'ai', text, result, model, elapsed, timestamp: nowStr() }]), []);

  const pushHistory = useCallback((role, content) =>
    setHistory(prev => [...prev.slice(-10), { role, content }]), []);

  // ── Streaming bubble update ───────────────────────────────────
  const updateStreamMsg = useCallback((id, patch) =>
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m)), []);

  // ── Core send logic ───────────────────────────────────────────
  const sendMessage = useCallback(async (text) => {
    text = text.trim();
    if (!text || isLoading) return;

    const useGemini = geminiApiKey && aiMode === 'gemini';
    const useOllama = ollamaRunning && ollamaModel && aiMode === 'ollama';
    const useClaude = claudeApiKey  && aiMode === 'claude';

    // ── Exact memory match → instant bypass ───────────────────
    const exactHit = memoryExactMatch(text);
    if (exactHit) {
      addUserMsg(text);
      setIsLoading(true);
      const result = await runAction(exactHit.action);
      setIsLoading(false);
      addAiMsg(`Running **${exactHit.phrase}**`, result, '⚡ instant');
      await memorySave(exactHit.phrase, exactHit.action);
      return;
    }

    // ── Fuzzy match → show confirm bar ─────────────────────────
    const fuzzyHit = memoryFuzzyMatch(text);
    if (fuzzyHit) {
      addUserMsg(text);
      pushHistory('user', text);
      setFuzzyPending({ entry: fuzzyHit, originalText: text });
      return;
    }

    if (!useOllama && !useClaude && !useGemini) {
      showToast('No AI connected — open Settings', 'error');
      return;
    }

    addUserMsg(text);
    pushHistory('user', text);
    setIsLoading(true);

    const prompt = promptRef.current || buildPrompt(sysInfo);
    const ctx    = history.slice(-3);

    if (useOllama) {
      await _streamOllama(text, ctx, prompt);
    } else if (useClaude) {
      await _claudeRequest(text, ctx, prompt);
    } else if (useGemini) {
      await _geminiRequest(text, ctx, prompt);
    }
  }, [
    isLoading, ollamaRunning, ollamaModel, ollamaHost,
    claudeApiKey, aiMode, history,
    memoryExactMatch, memoryFuzzyMatch, memorySave,
    addUserMsg, addAiMsg, pushHistory, runAction, showToast,
  ]);

  // ── Ollama streaming ──────────────────────────────────────────
  const _streamOllama = useCallback(async (originalText, ctx, prompt) => {
    window.aria.removeStreamListeners();

    const msgId   = nextId();
    const startMs = Date.now();
    let accumulated  = '';
    let done         = false;

    // Batching: buffer tokens and flush every 30ms to avoid per-token re-renders
    let pendingText  = '';
    let flushTimer   = null;
    const flushNow = () => {
      if (!pendingText || done) return;
      const snap = pendingText;
      pendingText = '';
      const visible = snap
        .replace(/```json[\s\S]*?```/g, '')
        .replace(/```json[\s\S]*$/, '')
        .replace(/^\s*`+\s*$/gm, '')
        .trim();
      updateStreamMsg(msgId, { text: visible, isStreaming: true });
    };

    setMessages(prev => [...prev, {
      id: msgId, role: 'ai', text: '', isStreaming: true,
      model: ollamaModel, timestamp: nowStr(),
    }]);

    // Client-side elapsed timer — 1s tick, no IPC needed
    const elapsedTimer = setInterval(() => {
      if (done) { clearInterval(elapsedTimer); return; }
      updateStreamMsg(msgId, { elapsed: ((Date.now() - startMs) / 1000).toFixed(1) });
    }, 1000);

    window.aria.onStreamToken((token) => {
      if (done) return;
      accumulated += token;
      pendingText  = accumulated; // always flush the full accumulated visible text
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushNow, 30);
    });

    window.aria.onStreamDone(async (fullText) => {
      if (done) return;
      done = true;
      clearTimeout(flushTimer);
      clearInterval(elapsedTimer);
      window.aria.removeStreamListeners();
      setIsLoading(false);

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      const display = stripJson(fullText);
      const result  = await parseAndRun(fullText, originalText, memorySave);

      updateStreamMsg(msgId, {
        text: display || '✓',
        isStreaming: false,
        result,
        model: ollamaModel,
        elapsed,
      });
      pushHistory('assistant', fullText);
    });

    window.aria.onStreamError((err) => {
      if (done) return;
      done = true;
      clearTimeout(flushTimer);
      clearInterval(elapsedTimer);
      window.aria.removeStreamListeners();
      setIsLoading(false);
      updateStreamMsg(msgId, { text: `⚠️ ${err}`, isStreaming: false });
    });

    const r = await window.aria.ollamaChat(ollamaModel, ctx, prompt, ollamaHost);
    if (!done && !r.ok) {
      done = true;
      clearTimeout(flushTimer);
      clearInterval(elapsedTimer);
      window.aria.removeStreamListeners();
      setIsLoading(false);
      updateStreamMsg(msgId, { text: `⚠️ ${r.error}`, isStreaming: false });
    }
  }, [ollamaModel, ollamaHost, parseAndRun, memorySave, updateStreamMsg, pushHistory]);

  // ── Claude non-streaming ──────────────────────────────────────
  const _claudeRequest = useCallback(async (originalText, ctx, prompt) => {
    try {
      const r = await window.aria.aiMessage(claudeApiKey, ctx, prompt);
      setIsLoading(false);
      if (!r.ok) { addAiMsg(`⚠️ ${r.error}`, null, 'Claude'); return; }
      const raw     = (r.content || []).map(c => c.text || '').join('');
      const display = stripJson(raw);
      const result  = await parseAndRun(raw, originalText, memorySave);
      addAiMsg(display || '✓', result, 'Claude');
      pushHistory('assistant', raw);
    } catch(e) {
      setIsLoading(false);
      addAiMsg(`⚠️ ${e.message}`, null, 'Claude');
    }
  }, [claudeApiKey, parseAndRun, memorySave, addAiMsg, pushHistory]);

  const _geminiRequest = useCallback(async (originalText, ctx, prompt) => {
    try {
      const r = await window.aria.geminiMessage(geminiApiKey, ctx, prompt);
      setIsLoading(false);
      if (!r.ok) { addAiMsg(`⚠️ ${r.error}`, null, 'Gemini'); return; }
      const display = stripJson(r.text);
      const result  = await parseAndRun(r.text, originalText, memorySave);
      addAiMsg(display || '✓', result, 'Gemini');
      pushHistory('assistant', r.text);
    } catch(e) {
      setIsLoading(false);
      addAiMsg(`⚠️ ${e.message}`, null, 'Gemini');
    }
  }, [geminiApiKey, parseAndRun, memorySave, addAiMsg, pushHistory]);

  // ── Fuzzy confirm actions ─────────────────────────────────────
  const fuzzyConfirmRun = useCallback(async () => {
    if (!fuzzyPending) return;
    const { entry } = fuzzyPending;
    setFuzzyPending(null);
    if (!entry) return;
    setIsLoading(true);
    const result = await runAction(entry.action);
    setIsLoading(false);
    addAiMsg(`Running **${entry.phrase}**`, result, '⚡ memory');
    await memorySave(entry.phrase, entry.action);
  }, [fuzzyPending, runAction, addAiMsg, memorySave]);

  const fuzzyConfirmAsk = useCallback(async () => {
    if (!fuzzyPending) return;
    const { originalText } = fuzzyPending;
    setFuzzyPending(null);
    if (!originalText) return;

    const useGemini = geminiApiKey && aiMode === 'gemini';
    const useOllama = ollamaRunning && ollamaModel && aiMode === 'ollama';
    const useClaude = claudeApiKey  && aiMode === 'claude';
    if (!useOllama && !useClaude && !useGemini) { showToast('No AI connected', 'error'); return; }

    setIsLoading(true);
    const prompt = promptRef.current || buildPrompt(sysInfo);
    const ctx    = history.slice(-3);
    if (useOllama) await _streamOllama(originalText, ctx, prompt);
    else if (useClaude) await _claudeRequest(originalText, ctx, prompt);
    else if (useGemini) await _geminiRequest(originalText, ctx, prompt);
  }, [
    fuzzyPending, ollamaRunning, ollamaModel, claudeApiKey,
    aiMode, history, _streamOllama, _claudeRequest, _geminiRequest, showToast,
  ]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setHistory([]);
  }, []);

  return {
    messages, isLoading, fuzzyPending,
    sendMessage, showWelcome, clearMessages,
    fuzzyConfirmRun, fuzzyConfirmAsk,
    setFuzzyPending,
  };
}
