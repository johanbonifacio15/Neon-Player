(function () {
  'use strict';

  // =====================================================
  //  ESTADO
  // =====================================================
  const audio = new Audio();
  let tracks = [];        // [{id, name, size, added}]
  let playlists = [];     // [{id, name, trackIds: []}]
  let view = 'lib';       // 'lib' o el id de una playlist
  let queueIds = [];      // cola de reproducción (ids) del contexto activo
  let currentId = null;   // id de la canción que suena
  let shuffle = false;
  let repeat = 'off';     // 'off' | 'all' | 'one'

  const $ = (id) => document.getElementById(id);
  const msg = (t) => { $('msg').textContent = t; };

  const trackById = (id) => tracks.find((t) => t.id === id);
  const getPlaylist = (id) => playlists.find((p) => p.id === id);

  // ids de las canciones que se ven en pantalla ahora mismo
  function visibleIds() {
    if (view === 'lib') return tracks.map((t) => t.id);
    const p = getPlaylist(view);
    return p ? p.trackIds.filter((id) => trackById(id)) : [];
  }

  // =====================================================
  //  PREFERENCIAS (volumen, aleatorio, repetir)
  // =====================================================
  const PREF_KEY = 'neonplayer.prefs';

  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ vol: audio.volume, shuffle, repeat }));
    } catch (e) { /* sin almacenamiento: no pasa nada */ }
  }

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (typeof p.vol === 'number') audio.volume = Math.min(1, Math.max(0, p.vol));
      if (typeof p.shuffle === 'boolean') shuffle = p.shuffle;
      if (['off', 'all', 'one'].includes(p.repeat)) repeat = p.repeat;
    } catch (e) { /* ignorar */ }
  }

  // =====================================================
  //  API DEL SERVIDOR
  // =====================================================
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/api' + path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
    if (!res.ok) throw new Error((data && data.error) || 'error ' + res.status);
    return data;
  }

  // ejecuta una operación y, si falla, muestra el motivo en la línea de mensajes
  async function safe(fn, errMsg) {
    try {
      return await fn();
    } catch (e) {
      msg(errMsg + ' (' + e.message + ')');
      return undefined;
    }
  }

  // subida con barra de progreso (fetch no permite medirla)
  function uploadFiles(form, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/tracks');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignorar */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data || []);
        else reject(new Error((data && data.error) || 'error ' + xhr.status));
      };
      xhr.onerror = () => reject(new Error('sin conexión con el servidor'));
      xhr.send(form);
    });
  }

  // =====================================================
  //  UTILIDADES
  // =====================================================
  function fmt(s) {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return m + ':' + String(r).padStart(2, '0');
  }
  const size = (b) => (b / 1048576).toFixed(1) + ' MB';
  const setFill = (el) => {
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--p', pct + '%');
  };

  // ---------- Diálogo propio (reemplaza prompt y confirm) ----------
  const dlgEl = $('dialog');

  function openDialog({ title, text, input, value, okLabel, danger }) {
    return new Promise((resolve) => {
      const modal = bootstrap.Modal.getOrCreateInstance(dlgEl);
      const form = $('dlgForm');
      const inp = $('dlgInput');
      const ok = $('dlgOk');
      let result = null;                       // null = cancelado

      $('dlgTitle').textContent = title;
      $('dlgText').textContent = text || '';
      $('dlgText').classList.toggle('d-none', !text);
      inp.classList.toggle('d-none', !input);
      inp.value = value || '';
      ok.textContent = okLabel || 'ACEPTAR';
      ok.classList.toggle('danger', !!danger);

      const onSubmit = (e) => {
        e.preventDefault();
        result = input ? inp.value.trim() : true;
        modal.hide();
      };
      const onShown = () => { if (input) { inp.focus(); inp.select(); } else ok.focus(); };
      const onHidden = () => {
        form.removeEventListener('submit', onSubmit);
        dlgEl.removeEventListener('shown.bs.modal', onShown);
        dlgEl.removeEventListener('hidden.bs.modal', onHidden);
        resolve(result);
      };

      form.addEventListener('submit', onSubmit);
      dlgEl.addEventListener('shown.bs.modal', onShown);
      dlgEl.addEventListener('hidden.bs.modal', onHidden);
      modal.show();
    });
  }

  const askText = (title, text, value) =>
    openDialog({ title, text, input: true, value, okLabel: 'GUARDAR' });

  const askConfirm = (title, text, okLabel) =>
    openDialog({ title, text, okLabel: okLabel || 'ELIMINAR', danger: true });

  // =====================================================
  //  VISUALIZADOR (Web Audio API)
  // =====================================================
  const canvas = $('viz');
  const ctx2d = canvas.getContext('2d');
  let actx = null;
  let analyser = null;
  let freq = null;

  function setupAnalyser() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      const src = actx.createMediaElementSource(audio);
      analyser = actx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.82;
      src.connect(analyser);
      analyser.connect(actx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
    }
    if (actx.state === 'suspended') actx.resume();
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function draw() {
    requestAnimationFrame(draw);
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);

    const bars = 48;
    const gap = 3 * (window.devicePixelRatio || 1);
    const bw = (w - gap * (bars - 1)) / bars;
    const live = analyser && !audio.paused;
    if (live) analyser.getByteFrequencyData(freq);

    const grad = ctx2d.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, '#00f0ff');
    grad.addColorStop(1, '#ff2a6d');
    ctx2d.fillStyle = grad;
    ctx2d.shadowColor = '#00f0ff';
    ctx2d.shadowBlur = 10;

    for (let i = 0; i < bars; i++) {
      const v = live
        ? freq[Math.floor((i / bars) * freq.length * 0.8)] / 255
        : 0.03 + 0.02 * Math.sin(Date.now() / 600 + i * 0.6);
      const bh = Math.max(2, v * h);
      ctx2d.fillRect(i * (bw + gap), h - bh, bw, bh);
    }
  }
  draw();

  // =====================================================
  //  RENDER
  // =====================================================
  function renderTabs() {
    const box = $('tabs');
    box.innerHTML = '';
    const mk = (label, active, fn, cls) => {
      const b = document.createElement('button');
      b.className = 'tab-neon' + (cls ? ' ' + cls : '') + (active ? ' active' : '');
      b.textContent = label;
      b.onclick = fn;
      box.appendChild(b);
    };
    mk('📚 Biblioteca', view === 'lib', () => setView('lib'));
    playlists.forEach((p) => mk('♫ ' + p.name, view === p.id, () => setView(p.id)));
    mk('＋ Nueva', false, () => newPlaylist(), 'add');
  }

  function renderActions() {
    const box = $('actions');
    box.innerHTML = '';
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.onclick = fn;
      box.appendChild(b);
    };
    if (view === 'lib') {
      mk('PURGAR TODO', 'btn-danger-neon', purgeAll);
    } else {
      mk('RENOMBRAR', 'btn-ghost-neon', renamePlaylist);
      mk('ELIMINAR', 'btn-danger-neon', deletePlaylist);
    }
  }

  // menú desplegable (Bootstrap) para añadir una canción a una playlist
  function buildAddMenu(track) {
    const wrap = document.createElement('div');
    wrap.className = 'dropdown';

    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.textContent = '＋';
    btn.title = 'Añadir a playlist';
    btn.setAttribute('aria-label', 'Añadir a playlist');
    btn.setAttribute('data-bs-toggle', 'dropdown');
    btn.setAttribute('aria-expanded', 'false');

    const menu = document.createElement('ul');
    menu.className = 'dropdown-menu dropdown-menu-end';

    const head = document.createElement('li');
    head.innerHTML = '<h6 class="dropdown-header">AÑADIR A PLAYLIST</h6>';
    menu.appendChild(head);

    playlists.forEach((p) => {
      const inside = p.trackIds.includes(track.id);
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'dropdown-item' + (inside ? ' in' : '');
      b.textContent = (inside ? '✓ ' : '') + p.name;
      b.onclick = () => addToPlaylist(p.id, track.id);
      li.appendChild(b);
      menu.appendChild(li);
    });

    if (playlists.length) {
      const hr = document.createElement('li');
      hr.innerHTML = '<hr class="dropdown-divider">';
      menu.appendChild(hr);
    }
    const li = document.createElement('li');
    const nb = document.createElement('button');
    nb.className = 'dropdown-item new';
    nb.textContent = '＋ Nueva playlist…';
    nb.onclick = () => newPlaylist(track.id);
    li.appendChild(nb);
    menu.appendChild(li);

    wrap.append(btn, menu);
    return wrap;
  }

  function render() {
    renderTabs();
    renderActions();

    const pl = view === 'lib' ? null : getPlaylist(view);
    $('viewLabel').textContent = pl ? 'PLAYLIST // ' + pl.name.toUpperCase() : 'LIBRARY';

    const ids = visibleIds();
    $('count').textContent = pl
      ? ids.length + (ids.length === 1 ? ' audio en esta playlist' : ' audios en esta playlist')
      : ids.length + (ids.length === 1 ? ' audio guardado' : ' audios guardados');

    const ul = $('list');
    ul.innerHTML = '';

    if (!ids.length) {
      ul.innerHTML = pl
        ? '<li class="empty">// playlist vacía. añade canciones con ＋ desde la biblioteca //</li>'
        : '<li class="empty">// sin datos. carga algunos MP3 //</li>';
      return;
    }

    ids.forEach((id, i) => {
      const t = trackById(id);
      const li = document.createElement('li');
      li.className = 'track-item' + (id === currentId ? ' active-track' : '');

      const num = document.createElement('span');
      num.className = 'track-num';
      if (id === currentId) num.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>';
      else num.textContent = String(i + 1).padStart(2, '0');

      const info = document.createElement('div');
      info.className = 'track-info';
      const name = document.createElement('div');
      name.className = 'track-name';
      name.textContent = t.name;
      const meta = document.createElement('div');
      meta.className = 'track-meta';
      meta.textContent = size(t.size);
      info.append(name, meta);

      const acts = document.createElement('div');
      acts.className = 'acts';

      const edit = document.createElement('button');
      edit.className = 'icon-btn';
      edit.textContent = '✎';
      edit.title = 'Renombrar';
      edit.setAttribute('aria-label', 'Renombrar');
      edit.onclick = () => renameTrack(id);
      acts.appendChild(edit);

      if (view === 'lib') {
        acts.appendChild(buildAddMenu(t));
        const del = document.createElement('button');
        del.className = 'icon-btn del';
        del.textContent = '✕';
        del.title = 'Eliminar de la biblioteca';
        del.setAttribute('aria-label', 'Eliminar');
        del.onclick = () => removeTrack(id);
        acts.appendChild(del);
      } else {
        const rm = document.createElement('button');
        rm.className = 'icon-btn del';
        rm.textContent = '⊖';
        rm.title = 'Quitar de la playlist';
        rm.setAttribute('aria-label', 'Quitar de la playlist');
        rm.onclick = () => removeFromPlaylist(id);
        acts.appendChild(rm);
      }

      li.append(num, info, acts);
      // clic en la fila = reproducir (menos si se pulsó un botón de acción)
      li.onclick = (e) => {
        if (e.target.closest('.acts')) return;
        playTrack(id, ids);
      };
      ul.appendChild(li);
    });
  }

  async function reload() {
    try {
      const [tr, pl] = await Promise.all([api('GET', '/tracks'), api('GET', '/playlists')]);
      tracks = tr || [];
      playlists = pl || [];
    } catch (e) {
      msg('no se pudo conectar con el servidor. ¿está encendido?');
      tracks = [];
      playlists = [];
    }
    if (view !== 'lib' && !getPlaylist(view)) view = 'lib';
    render();
  }

  function setView(v) {
    view = v;
    render();
  }

  // =====================================================
  //  PLAYLISTS
  // =====================================================
  async function newPlaylist(withTrackId) {
    const name = await askText('NUEVA PLAYLIST', 'Ponle un nombre:');
    if (!name) return;
    const created = await safe(
      () => api('POST', '/playlists', { name, trackIds: withTrackId != null ? [withTrackId] : [] }),
      'no se pudo crear la playlist'
    );
    if (!created) return;
    if (withTrackId == null) view = created.id;
    await reload();
    msg(withTrackId != null
      ? 'playlist “' + name + '” creada con la canción.'
      : 'playlist “' + name + '” creada.');
  }

  async function addToPlaylist(pid, tid) {
    const p = getPlaylist(pid);
    if (!p) return;
    if (p.trackIds.includes(tid)) { msg('ya está en “' + p.name + '”.'); return; }
    const ok = await safe(
      () => api('POST', '/playlists/' + pid + '/tracks', { trackIds: [tid] }),
      'no se pudo añadir a la playlist'
    );
    if (!ok) return;
    p.trackIds.push(tid);
    msg('añadida a “' + p.name + '”.');
    render();
  }

  async function removeFromPlaylist(tid) {
    const p = getPlaylist(view);
    if (!p) return;
    const ok = await safe(
      () => api('DELETE', '/playlists/' + p.id + '/tracks/' + tid),
      'no se pudo quitar de la playlist'
    );
    if (!ok) return;
    p.trackIds = p.trackIds.filter((x) => x !== tid);
    render();
  }

  async function renamePlaylist() {
    const p = getPlaylist(view);
    if (!p) return;
    const nuevo = await askText('RENOMBRAR PLAYLIST', '', p.name);
    if (!nuevo) return;
    const ok = await safe(() => api('PATCH', '/playlists/' + p.id, { name: nuevo }), 'no se pudo renombrar');
    if (!ok) return;
    p.name = nuevo;
    render();
  }

  async function deletePlaylist() {
    const p = getPlaylist(view);
    if (!p || !(await askConfirm('ELIMINAR PLAYLIST', 'Se eliminará “' + p.name + '”. Las canciones no se borran.'))) return;
    const ok = await safe(() => api('DELETE', '/playlists/' + p.id), 'no se pudo eliminar la playlist');
    if (!ok) return;
    view = 'lib';
    await reload();
  }

  // =====================================================
  //  CANCIONES (renombrar / eliminar / purgar)
  // =====================================================
  async function renameTrack(id) {
    const t = trackById(id);
    if (!t) return;
    const nuevo = await askText('RENOMBRAR AUDIO', '', t.name);
    if (!nuevo) return;
    const ok = await safe(() => api('PATCH', '/tracks/' + id, { name: nuevo }), 'no se pudo renombrar');
    if (!ok) return;
    t.name = nuevo;
    if (id === currentId) $('now').textContent = nuevo;
    render();
  }

  function stopPlayback() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    currentId = null;
    $('now').textContent = 'Nada en reproducción';
    $('cur').textContent = '0:00';
    $('dur').textContent = '0:00';
    $('seek').value = 0;
    setFill($('seek'));
  }

  async function removeTrack(id) {
    // el servidor borra el archivo y la quita de todas las playlists
    const ok = await safe(() => api('DELETE', '/tracks/' + id), 'no se pudo eliminar');
    if (!ok) return;
    if (id === currentId) stopPlayback();
    queueIds = queueIds.filter((x) => x !== id);
    await reload();
  }

  async function purgeAll() {
    if (!tracks.length || !(await askConfirm('PURGAR TODO', 'Se borrarán todos los audios guardados y las playlists quedarán vacías.', 'PURGAR'))) return;
    const ok = await safe(() => api('DELETE', '/tracks'), 'no se pudo purgar');
    if (!ok) return;
    stopPlayback();
    queueIds = [];
    await reload();
  }

  // =====================================================
  //  REPRODUCCIÓN
  // =====================================================
  function playTrack(id, ids) {
    const t = trackById(id);
    if (!t) return;
    if (ids) queueIds = ids.slice();
    setupAnalyser();
    currentId = id;
    audio.src = '/api/tracks/' + id + '/audio';   // el servidor hace streaming del MP3
    audio.play().catch(() => {});
    $('now').textContent = t.name;
    updateMediaSession(t);
    render();
  }

  function togglePlay() {
    if (currentId === null) {
      const ids = visibleIds();
      if (!ids.length) return;
      const first = shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0];
      playTrack(first, ids);
      return;
    }
    setupAnalyser();
    audio.paused ? audio.play().catch(() => {}) : audio.pause();
  }

  function nextTrack(auto) {
    queueIds = queueIds.filter((id) => trackById(id));
    if (!queueIds.length) {
      queueIds = visibleIds();
      if (!queueIds.length) return;
    }
    if (auto && repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    let nid;
    if (shuffle && queueIds.length > 1) {
      do {
        nid = queueIds[Math.floor(Math.random() * queueIds.length)];
      } while (nid === currentId);
    } else {
      let n = queueIds.indexOf(currentId) + 1;
      if (n >= queueIds.length) {
        if (auto && repeat === 'off') {      // fin de la lista: se detiene
          audio.pause();
          audio.currentTime = 0;
          return;
        }
        n = 0;
      }
      nid = queueIds[n];
    }
    playTrack(nid);
  }

  function prevTrack() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    queueIds = queueIds.filter((id) => trackById(id));
    if (!queueIds.length) return;
    const idx = queueIds.indexOf(currentId);
    playTrack(queueIds[idx <= 0 ? queueIds.length - 1 : idx - 1]);
  }

  function seekBy(sec) {
    if (!audio.duration) return;
    audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + sec));
  }

  // ---------- volumen, mute, aleatorio, repetir ----------
  function updateMuteLabel() {
    const off = audio.muted || audio.volume === 0;
    $('mute').textContent = off ? 'MUTE' : 'VOL';
    $('mute').classList.toggle('on', off);
  }

  function setVolume(v) {
    v = Math.min(1, Math.max(0, v));
    audio.volume = v;
    if (v > 0) audio.muted = false;
    $('vol').value = v;
    setFill($('vol'));
    updateMuteLabel();
    savePrefs();
  }

  function toggleMute() {
    audio.muted = !audio.muted;
    updateMuteLabel();
  }

  function updateModes() {
    $('shuffle').classList.toggle('on', shuffle);
    const r = $('repeat');
    r.classList.toggle('on', repeat !== 'off');
    r.textContent = repeat === 'one' ? '↻1' : '↻';
    savePrefs();
  }

  function toggleShuffle() {
    shuffle = !shuffle;
    updateModes();
    msg('aleatorio: ' + (shuffle ? 'on' : 'off'));
  }

  function cycleRepeat() {
    repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    updateModes();
    msg('repetir: ' + { off: 'off', all: 'lista', one: 'canción' }[repeat]);
  }

  // ---------- eventos de los controles ----------
  $('play').onclick = togglePlay;
  $('next').onclick = () => nextTrack(false);
  $('prev').onclick = prevTrack;
  $('shuffle').onclick = toggleShuffle;
  $('repeat').onclick = cycleRepeat;
  $('mute').onclick = toggleMute;

  audio.onplay = () => { $('play').textContent = '⏸'; document.body.classList.add('playing'); };
  audio.onpause = () => { $('play').textContent = '▶'; document.body.classList.remove('playing'); };
  audio.onended = () => nextTrack(true);
  audio.onerror = () => { if (currentId !== null) msg('no se pudo reproducir esta canción.'); };
  audio.onloadedmetadata = () => { $('dur').textContent = fmt(audio.duration); };
  audio.ontimeupdate = () => {
    $('cur').textContent = fmt(audio.currentTime);
    if (audio.duration) {
      $('seek').value = (audio.currentTime / audio.duration) * 100;
      setFill($('seek'));
    }
  };
  $('seek').oninput = (e) => {
    setFill(e.target);
    if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
  };
  $('vol').oninput = (e) => setVolume(parseFloat(e.target.value));

  // =====================================================
  //  ATAJOS DE TECLADO (estilo Spotify / Apple Music)
  // =====================================================
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (document.body.classList.contains('modal-open')) return;
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'range')) return;
    if (e.altKey) return;
    // si hay un menú desplegable abierto, que Bootstrap maneje las flechas
    if (document.querySelector('.dropdown-menu.show')) return;

    const mod = e.ctrlKey || e.metaKey;

    if (mod) {
      if (e.key === 'ArrowRight') nextTrack(false);
      else if (e.key === 'ArrowLeft') prevTrack();
      else return;                       // deja pasar Ctrl+R, Ctrl+C, etc.
    } else {
      switch (e.key) {
        case ' ': togglePlay(); break;
        case 'ArrowRight': seekBy(5); break;
        case 'ArrowLeft': seekBy(-5); break;
        case 'ArrowUp':
          setVolume(audio.volume + 0.05);
          msg('volumen ' + Math.round(audio.volume * 100) + '%');
          break;
        case 'ArrowDown':
          setVolume(audio.volume - 0.05);
          msg('volumen ' + Math.round(audio.volume * 100) + '%');
          break;
        case 'm': case 'M': toggleMute(); break;
        case 's': case 'S': toggleShuffle(); break;
        case 'r': case 'R': cycleRepeat(); break;
        case '?':
          if (window.bootstrap) bootstrap.Collapse.getOrCreateInstance($('keys')).toggle();
          break;
        default: return;
      }
    }

    e.preventDefault();
    // evita que un botón/slider enfocado procese la misma tecla otra vez
    if (tag === 'BUTTON' || tag === 'INPUT') e.target.blur();
  });

  // =====================================================
  //  TECLAS MULTIMEDIA / PANTALLA DE BLOQUEO
  // =====================================================
  function updateMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: 'NEON//PLAYER' });
    } catch (e) { /* ignorar */ }
  }

  if ('mediaSession' in navigator) {
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) {} };
    set('play', () => audio.play().catch(() => {}));
    set('pause', () => audio.pause());
    set('previoustrack', prevTrack);
    set('nexttrack', () => nextTrack(false));
  }

  // =====================================================
  //  SUBIR ARCHIVOS AL SERVIDOR
  // =====================================================
  async function addFiles(files) {
    const mp3s = [...files].filter((f) => f.type === 'audio/mpeg' || /\.mp3$/i.test(f.name));
    if (!mp3s.length) { msg('solo se aceptan archivos MP3.'); return; }

    const form = new FormData();
    // los nombres van primero y en JSON para conservar tildes y ñ
    form.append('names', JSON.stringify(mp3s.map((f) => f.name)));
    mp3s.forEach((f) => form.append('files', f, f.name));

    const label = mp3s.length + (mp3s.length === 1 ? ' archivo' : ' archivos');
    try {
      msg('subiendo ' + label + '… 0%');
      const created = await uploadFiles(form, (p) => msg('subiendo ' + label + '… ' + p + '%'));
      const newIds = created.map((c) => c.id);

      // si estás dentro de una playlist, las nuevas también se añaden a ella
      const p = view === 'lib' ? null : getPlaylist(view);
      if (p && newIds.length) {
        await api('POST', '/playlists/' + p.id + '/tracks', { trackIds: newIds });
      }

      await reload();
      msg(newIds.length + (newIds.length === 1 ? ' audio guardado.' : ' audios guardados.'));
    } catch (e) {
      await reload();
      msg('no se pudo subir (' + e.message + ').');
    }
  }

  $('file').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); })
  );
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  // =====================================================
  //  INICIO
  // =====================================================
  loadPrefs();
  $('vol').value = audio.volume;
  setFill($('vol'));
  setFill($('seek'));
  updateMuteLabel();
  updateModes();
  reload();
})();