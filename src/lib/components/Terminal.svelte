<script>
  // Reusable tmux-backed terminal. Connects a websocket to workspace-api, which
  // runs `tmux new -A -s <wsId>-<sessionKey>` behind a PTY. The tmux session is
  // the durable thing — mount/unmount freely without affecting running work.
  // Used by the terminal tool (tab) and the agent Console (session ws_default-<id>).
  import { onMount, onDestroy } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import '@xterm/xterm/css/xterm.css';
  import { wsUrl, WS_TERM_PATH } from '$lib/config.js';
  import { themeStore, terminalTheme } from '$lib/theme.svelte.js';
  import { uploadImage, imageFromEvent, copyText, readClipboard } from '$lib/paste.js';
  import TermKeyBar from '$lib/components/TermKeyBar.svelte';

  /** @type {{ sessionKey: string, wsId: string, active?: boolean, onTitle?: (t: string) => void, onNeedsInput?: () => void }} */
  let { sessionKey, wsId, active = true, onTitle, onNeedsInput } = $props();

  /** @type {HTMLDivElement | null} */
  let host = $state(null);
  let status = $state('connecting');
  let isTouch = $state(false);
  let isMac = $state(false);
  // The modifier that forces a local text selection inside a mouse-reporting
  // TUI (see macOptionClickForcesSelection). Drives the copy hints below.
  let selMod = $derived(isMac ? '⌥' : 'Shift'); // ⌥ on mac, Shift elsewhere
  let showHint = $state(false); // brief one-time "how to select" tip on desktop
  let lastSel = ''; // most recent non-empty selection, kept so a later copy still has it

  // Best available selection: live xterm selection, then the last one we captured,
  // then any native DOM selection (iOS sometimes selects without xterm knowing).
  function currentSelection() {
    const x = term?.getSelection();
    if (x) return x;
    if (lastSel) return lastSel;
    try { const w = window.getSelection?.()?.toString(); if (w && w.trim()) return w; } catch {}
    return '';
  }

  // Dismiss the one-time "how to select" tip and remember it per-browser.
  function dismissHint() {
    if (!showHint) return;
    showHint = false;
    try { localStorage.setItem('term-copy-hint', '1'); } catch {}
  }

  // Briefly show a transient message in the status pill, then return to connected.
  /** @param {string} msg */
  function flashStatus(msg) {
    status = msg;
    setTimeout(() => { if (ws?.readyState === WebSocket.OPEN) status = 'connected'; }, 1200);
  }

  // Application-cursor-key mode (DECCKM) — tracked from output so arrow keys send
  // the right bytes inside full-screen TUIs (Claude Code menus).
  let appCursor = false;
  // Mouse reporting mode — when active (Claude Code enables it), xterm forwards
  // wheel events as mouse sequences directly to the program. We do the same on
  // touch: send \x1b[<64;...M / \x1b[<65;...M so Claude Code scrolls its
  // conversation view. When inactive, fall back to tmux copy-mode scroll.
  let mouseMode = false;  // any of 1000/1002/1003 active
  let sgrMouse  = false;  // DECSET 1006 (SGR extended coords) active
  let altScreen = false;  // DECSET 1049 (alternate screen) — kept for context
  /** @param {any} k */
  function pressKey(k) {
    let d = '';
    switch (k.key) {
      case 'ArrowUp': d = appCursor ? '\x1bOA' : '\x1b[A'; break;
      case 'ArrowDown': d = appCursor ? '\x1bOB' : '\x1b[B'; break;
      case 'ArrowRight': d = appCursor ? '\x1bOC' : '\x1b[C'; break;
      case 'ArrowLeft': d = appCursor ? '\x1bOD' : '\x1b[D'; break;
      case 'Escape': d = '\x1b'; break;
      case 'Tab': d = k.shift ? '\x1b[Z' : '\t'; break;
      case 'Enter': d = '\r'; break;
      default: if (k.ctrl) d = String.fromCharCode(k.keyCode & 31);
    }
    if (d) send({ t: 'i', d });
  }
  /** @type {import('@xterm/xterm').Terminal} */ let term;
  /** @type {import('@xterm/addon-fit').FitAddon} */ let fit;
  /** @type {WebSocket} */ let ws;
  /** @type {ResizeObserver} */ let ro;
  /** @type {(e: Event) => void} */ let onCopy;
  /** @type {() => void} */ let onSelect;
  /** @type {() => void} */ let onRefit;

  /** @param {object} obj */
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  // Last size we told tmux about — skip no-op resizes so fit()'s DOM mutation
  // can't feed the ResizeObserver back into an endless resize→redraw storm.
  let lastCols = 0, lastRows = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let refitTimer;
  /** @param {boolean} [force] re-send the size even if unchanged (manual resize) */
  function refit(force = false) {
    // ONLY the visible terminal may resize its tmux session. Each terminal tab is
    // its own tmux session with a single client, so `window-size largest` can't
    // protect it — whatever this one client reports IS the window size. A hidden
    // tab (display:none) measures a tiny ~10x6 host; if it sent that, it would
    // shrink the session and Claude Code would spam its wrapped statusline into
    // scrollback. `active` is the tab's visibility; offsetParent===null catches
    // any display:none host the prop hasn't caught yet. Either → never send.
    if (!active || !host || host.offsetParent === null) return;
    try {
      fit.fit();
      // Ignore the degenerate size a collapsing/zero-height host produces, and any
      // resize that doesn't actually change dimensions (unless forced).
      if (term.cols < 2 || term.rows < 2) return;
      if (!force && term.cols === lastCols && term.rows === lastRows) return;
      // Only record the size once it's actually SENT. send() no-ops while the ws is
      // still connecting, so recording here would let an early fit poison lastCols
      // and make ws.onopen skip the first real resize — the session would keep its
      // 80x24 default until a manual resize. Bail until the socket is open.
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      lastCols = term.cols; lastRows = term.rows;
      send({ t: 'r', cols: term.cols, rows: term.rows });
    } catch {}
  }
  // Re-fit across the next several frames until the measured size stops changing,
  // so a freshly shown/mounted terminal locks onto the real width on its own. The
  // layout has no width animation, so this converges in 1–2 frames and — via
  // refit()'s change-detection — sends at most one resize (no SIGWINCH storm).
  function settleRefit() {
    let prev = '', frames = 0;
    const tick = () => {
      refit();
      const sig = term ? `${term.cols}x${term.rows}` : '';
      const changed = sig !== prev;
      prev = sig;
      if (++frames < 12 && (changed || frames < 3)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  // Debounce ResizeObserver bursts to ONE fit after motion settles. A per-frame
  // fit isn't enough: a project switch animates the layout, so the host width
  // changes a little each frame for ~300ms — every distinct intermediate size is
  // a real resize, and each one SIGWINCHes the inner program (Claude Code) into
  // reprinting its output, storming the scrollback with duplicate lines. Trailing
  // debounce sends only the final size once the layout stops moving.
  function scheduleRefit() {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => refit(), 120);
  }
  function connect() {
    status = 'connecting';
    ws = new WebSocket(wsUrl(`${WS_TERM_PATH}/${sessionKey}?ws=${encodeURIComponent(wsId)}`));
    ws.onopen = () => { status = 'connected'; settleRefit(); };
    ws.onmessage = (e) => {
      const s = e.data;
      if (typeof s === 'string') {
        // BEL — terminal program is asking for attention (e.g. Claude Code permission prompt).
        if (onNeedsInput && s.includes('\x07')) onNeedsInput();
        const hi = s.lastIndexOf('\x1b[?1h');
        const lo = s.lastIndexOf('\x1b[?1l');
        if (hi !== -1 || lo !== -1) appCursor = hi > lo;
        // Track mouse reporting mode (1000=X10 1002=button 1003=any-event).
        const mOn  = Math.max(s.lastIndexOf('\x1b[?1000h'), s.lastIndexOf('\x1b[?1002h'), s.lastIndexOf('\x1b[?1003h'));
        const mOff = Math.max(s.lastIndexOf('\x1b[?1000l'), s.lastIndexOf('\x1b[?1002l'), s.lastIndexOf('\x1b[?1003l'));
        if (mOn !== -1 || mOff !== -1) mouseMode = mOn > mOff;
        // Track SGR extended mouse mode (1006) — determines sequence format.
        const sOn  = s.lastIndexOf('\x1b[?1006h');
        const sOff = s.lastIndexOf('\x1b[?1006l');
        if (sOn !== -1 || sOff !== -1) sgrMouse = sOn > sOff;
        // Track alternate screen.
        const aOn  = s.lastIndexOf('\x1b[?1049h');
        const aOff = s.lastIndexOf('\x1b[?1049l');
        if (aOn !== -1 || aOff !== -1) altScreen = aOn > aOff;
      }
      term.write(s);
    };
    ws.onclose = () => { status = 'closed'; };
    ws.onerror = () => { status = 'closed'; };
  }

  /** @param {ClipboardEvent | DragEvent} e */
  async function handlePaste(e) {
    const img = imageFromEvent(e);
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof (/** @type {any} */ (e).stopImmediatePropagation) === 'function') /** @type {any} */ (e).stopImmediatePropagation();
    await sendImage(img);
  }

  // iOS Safari never fires a `paste` event carrying an image into a focused div,
  // so touch users can't paste screenshots. The key-bar image button opens the
  // native photo/file picker and routes the chosen image through the same upload.
  /** @type {HTMLInputElement} */ let fileInput;
  function pickImage() { fileInput?.click(); }
  /** @param {Event} e */
  async function onFilePicked(e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const f = input.files?.[0];
    input.value = ''; // allow re-picking the same file
    if (f) await sendImage(f);
  }

  // iOS can't deliver a clipboard image via the `paste` event, but the async
  // Clipboard API works inside a tap gesture. The key-bar clipboard button reads
  // the OS clipboard directly: an image is uploaded like a screenshot, plain text
  // is typed into the terminal as if pasted.
  async function pasteClipboard() {
    status = 'reading clipboard…';
    try {
      const { image, text } = await readClipboard();
      if (image) return sendImage(image);
      if (text) {
        send({ t: 'i', d: text });
        status = 'pasted text';
      } else {
        status = 'clipboard empty';
      }
    } catch {
      status = 'clipboard blocked';
    }
    setTimeout(() => { if (ws?.readyState === WebSocket.OPEN) status = 'connected'; }, 1500);
  }

  /** @param {File} img */
  async function sendImage(img) {
    status = 'uploading image…';
    try { const r = await uploadImage(img, sessionKey, wsId); status = r.injected ? 'image path inserted' : 'image saved'; }
    catch { status = 'image upload failed'; }
    setTimeout(() => { if (ws?.readyState === WebSocket.OPEN) status = 'connected'; }, 1500);
  }

  // Touch swipe → scroll. Mirrors what xterm does on desktop for mouse wheel:
  //
  // • Alternate screen (Claude Code TUI, no scrollback): xterm converts wheel
  //   events to arrow key presses and sends them to the running program. We do
  //   the same — swipe down → Arrow Up (×N), swipe up → Arrow Down (×N).
  //
  // • Main screen (shell, scrollback exists in tmux): send {t:'scroll'} over
  //   the websocket; the server enters tmux copy-mode and scrolls the buffer.
  //   Tmux -e flag auto-exits copy-mode when scrolled back to live view.
  let touchLastY = 0;
  let touchScrollAcc = 0;
  /** @type {HTMLElement | null} */ let xtermViewport = null;
  /** @param {TouchEvent} e */
  function onTermTouchStart(e) { if (e.touches.length) { touchLastY = e.touches[0].clientY; touchScrollAcc = 0; } }
  /** @param {TouchEvent} e */
  function onTermTouchMove(e) {
    if (!e.touches.length) return;
    const y = e.touches[0].clientY;
    const delta = y - touchLastY; // positive = finger down = scroll up (older)
    touchLastY = y;
    touchScrollAcc += delta;
    const lineH = 20;
    const lines = Math.trunc(touchScrollAcc / lineH);
    if (lines !== 0) {
      touchScrollAcc -= lines * lineH;
      if (mouseMode) {
        // Mouse mode active (Claude Code): send mouse wheel sequences exactly as
        // xterm does on desktop. lines>0 = swipe down = scroll up = button 64.
        // SGR format \x1b[<btn;col;rowM (1006 active) or X10 \x1b[M<bytes>.
        const btn = lines > 0 ? 64 : 65;
        const seq = sgrMouse
          ? `\x1b[<${btn};1;1M`
          : `\x1b[M${String.fromCharCode(btn + 32, 33, 33)}`;
        send({ t: 'i', d: seq.repeat(Math.abs(lines)) });
      } else {
        // No mouse mode (plain shell): scroll tmux's scrollback via copy-mode.
        send({ t: 'scroll', lines });
      }
    }
    e.preventDefault();
    e.stopPropagation();
  }

  onMount(() => {
    isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    // Show the "how to select" tip once per browser, on desktop only.
    try { if (!isTouch && !localStorage.getItem('term-copy-hint')) showHint = true; } catch {}
    const el = host;
    if (!el) return;
    term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13, cursorBlink: true, scrollback: 10000,
      // Inside a mouse-reporting TUI (Claude Code, vim) a plain drag is sent to
      // the app, so xterm makes no selection. The standard escape is a modifier-
      // drag that forces a LOCAL selection: Shift on Linux/Windows (xterm's
      // built-in), Option on macOS — but the macOS path only works when this is
      // on (it defaults to false). Without it, Mac users literally cannot select
      // text in a Claude pane. This is the single setting that unblocks copy.
      macOptionClickForcesSelection: true,
      theme: terminalTheme()
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    // OSC 52: tmux (set-clipboard on) sends the copy buffer as `52;c;<base64>`
    // when you select with the mouse/trackpad in a pane. Decode it and write the
    // OS clipboard — this is what makes selection-copy work uniformly, including
    // inside mouse-mode TUIs (Claude Code) where xterm's own selection is empty.
    term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(';');
      const b64 = semi >= 0 ? data.slice(semi + 1) : data;
      if (!b64 || b64 === '?') return true; // query, not a set — ignore
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        if (text) {
          lastSel = text;
          copyText(text).then((ok) => { if (ok) flashStatus(`copied ${text.length}`); });
        }
      } catch { /* malformed payload */ }
      return true;
    });
    // The browser/OS eats Cmd/Ctrl+L (address bar) and Cmd/Ctrl+K (search) before
    // they reach the PTY. Intercept them: Cmd/Ctrl+L forwards Ctrl+U (\x15) to the
    // shell/Claude Code (clear the typed input line), Cmd/Ctrl+K clears this terminal locally.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // Shift+Enter: insert a newline instead of submitting. xterm sends a plain
      // \r for both Enter and Shift+Enter, so Claude Code can't tell them apart.
      // Forward ESC+CR (\x1b\r) — the sequence `claude /terminal-setup` binds to
      // Shift+Enter — so Claude Code (and shells) treat it as a soft newline.
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); e.stopPropagation();
        send({ t: 'i', d: '\x1b\r' });
        return false;
      }
      const mod = e.ctrlKey || e.metaKey;
      // Cmd+C (mac) / Ctrl+Shift+C: copy the current selection. preventDefault so
      // the browser can't fall back to copying stray DOM text (e.g. a button
      // label). Plain Ctrl+C falls through below to SIGINT.
      if (mod && e.key.toLowerCase() === 'c' && (e.metaKey || e.shiftKey)) {
        e.preventDefault(); e.stopPropagation();
        const sel = currentSelection();
        // No selection usually means the user dragged inside a mouse-reporting
        // pane (Claude) without the modifier — point them at the right gesture.
        if (!sel) { flashStatus(`${selMod}-drag to select, then copy`); return false; }
        copyText(sel).then((ok) => flashStatus(ok ? `copied ${sel.length}` : 'copy failed'));
        return false;
      }
      if (!mod || e.altKey || e.shiftKey) return true;
      const k = e.key.toLowerCase();
      if (k === 'l') {
        e.preventDefault(); e.stopPropagation();
        send({ t: 'i', d: '\x15' });
        return false;
      }
      if (k === 'k') {
        e.preventDefault(); e.stopPropagation();
        term.clear();
        return false;
      }
      return true;
    });
    // Inside mouse-reporting TUIs (Claude Code) a plain drag goes to the app,
    // so a modifier-drag (⌥ on mac / Shift elsewhere) is needed to select.
    // Copy: Cmd/Ctrl+Shift+C, right-click → Copy — all go through copyText().
    term.onSelectionChange(() => {
      const s = term.getSelection();
      if (s) { lastSel = s; dismissHint(); }
    });
    // iOS often makes a native DOM selection without xterm knowing — capture it too.
    onSelect = () => {
      try { const w = window.getSelection?.()?.toString(); if (w && w.trim()) lastSel = w; } catch {}
    };
    document.addEventListener('selectionchange', onSelect);
    term.onData((d) => send({ t: 'i', d }));
    // Pane title (OSC 0/2) forwarded by tmux set-titles — lets the host tab
    // auto-name itself from Claude Code's task summary. Opt-in via prop so the
    // agent Console (which reuses this component) keeps its own name.
    if (onTitle) term.onTitleChange((t) => onTitle(t));
    settleRefit();
    connect();
    ro = new ResizeObserver(() => scheduleRefit());
    ro.observe(el);
    // Native copy event — fired by Cmd/Ctrl+C, right-click → Copy, and Edit → Copy.
    // Bound to document (not just el) so Cmd+C works even when focus isn't inside
    // the terminal element. Only the visible terminal (active) services it, and
    // only when it owns a selection — otherwise let the browser copy normally.
    onCopy = (e) => {
      if (!active || !term?.hasSelection()) return;
      const sel = term.getSelection();
      if (!sel) return;
      /** @type {ClipboardEvent} */ (e).clipboardData?.setData('text/plain', sel);
      e.preventDefault();
      flashStatus('copied');
    };
    document.addEventListener('copy', onCopy);
    // Manual "resize terminals" button in the header dispatches this — force a
    // refit (and re-send the size) on every mounted terminal, visible or not.
    onRefit = () => { if (active) setTimeout(() => { refit(true); term.focus(); }, 0); else refit(true); };
    window.addEventListener('workspace:refit', onRefit);
    el.addEventListener('paste', handlePaste, true);
    el.addEventListener('drop', handlePaste, true);
    el.addEventListener('dragover', (e) => e.preventDefault(), true);
    if (isTouch) {
      el.style.touchAction = 'none'; // we scroll the buffer ourselves; don't pan the page
      // Also set touch-action on the xterm viewport directly — on some iOS versions
      // a child element's touch-action:auto can override an ancestor's none.
      xtermViewport = el.querySelector('.xterm-viewport');
      if (xtermViewport) xtermViewport.style.touchAction = 'none';
      // Use capture so our handlers fire before xterm's child-element handlers, and
      // stopPropagation() in onTermTouchMove prevents xterm from double-scrolling.
      el.addEventListener('touchstart', onTermTouchStart, { passive: true, capture: true });
      el.addEventListener('touchmove', onTermTouchMove, { passive: false, capture: true });
    }
  });
  onDestroy(() => { clearTimeout(refitTimer); ro?.disconnect(); ws?.close(); term?.dispose(); if (onCopy) document.removeEventListener('copy', onCopy); if (onSelect) document.removeEventListener('selectionchange', onSelect); if (onRefit) window.removeEventListener('workspace:refit', onRefit); });

  // Re-fit + focus when this terminal becomes visible. xterm doesn't repaint its
  // buffer while the host is display:none, so going hidden→visible leaves the
  // screen blank until something new is written — force a full refresh to redraw
  // the existing buffer.
  $effect(() => {
    if (active && term) setTimeout(() => {
      // settleRefit() re-fits across frames until the width stabilizes (sending
      // only on a real change, so no SIGWINCH storm), so a tab shown by a project
      // or tab switch fills the full width on its own — no manual resize.
      settleRefit();
      try { term.refresh(0, term.rows - 1); } catch {} // repaint buffer (hidden→visible)
      term.focus();
    }, 0);
  });

  // Live-swap the xterm palette when the app theme changes (light/dark/system).
  $effect(() => {
    themeStore.dark; // track resolved theme so this re-runs on change
    if (term) term.options.theme = terminalTheme();
  });
</script>

<div class="flex flex-col h-full w-full">
  <div class="relative flex-1 min-h-0">
    <div bind:this={host} class="h-full w-full px-1 pt-1"></div>
    {#if status !== 'connected'}
      <div class="absolute top-1 right-2 text-xs px-2 py-0.5 rounded bg-elevated text-muted">
        {status}
        {#if status === 'closed'}<button class="ml-2 text-accent hover:underline" onclick={connect}>reconnect</button>{/if}
      </div>
    {/if}
    {#if showHint && active}
      <button
        class="absolute bottom-2 right-2 text-xs px-2 py-1 rounded bg-elevated text-muted hover:text-content border border-line"
        title="Dismiss" onclick={dismissHint}>
        Tip: <span class="text-content">{selMod}-drag</span> to select text in Claude, then ⌘/Ctrl-C ·&nbsp;✕
      </button>
    {/if}
  </div>

  {#if isTouch}
    <TermKeyBar onKey={pressKey} onImage={pickImage} onPaste={pasteClipboard} />
  {/if}
  <input bind:this={fileInput} type="file" accept="image/*" class="hidden" onchange={onFilePicked} />
</div>
