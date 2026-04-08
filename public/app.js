/* global faceapi, tf */
(function () {
  "use strict";

  /** API com CORS aberto (*). Tentamos primeiro direto do telemóvel; se falhar, o proxy no mesmo site (Render) costuma funcionar. */
  const API_V2 = "https://dadosabertos.camara.leg.br/api/v2";

  async function fetchApiV2(pathAndQuery) {
    var candidates = [];
    try {
      if (
        typeof location !== "undefined" &&
        (location.protocol === "http:" || location.protocol === "https:")
      ) {
        candidates.push({ url: "/dados-abertos/v2" + pathAndQuery, label: "servidor desta página" });
      }
    } catch (_) {}
    candidates.push({ url: API_V2 + pathAndQuery, label: "API direta (dadosabertos.camara.leg.br)" });
    var lastDetail = "";
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      try {
        var r = await fetch(c.url);
        if (r.status === 429) {
          await new Promise(function (res) {
            setTimeout(res, 3200);
          });
          r = await fetch(c.url);
        }
        if (r.ok) return r;
        lastDetail = c.label + " respondeu HTTP " + r.status;
      } catch (err) {
        lastDetail = c.label + ": " + ((err && err.message) || String(err));
      }
    }
    throw new Error("Não foi possível obter dados da Câmara. " + lastDetail);
  }
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";
  const DB_NAME = "camara-face-identifica-v1";
  const STORE = "gallery";
  const POOL = 4;

  /**
   * Sensibilidade do reconhecimento (distância euclidiana entre descritores).
   * Valores mais altos em MATCH_MAX_DIST aceitam mais correspondências fracas (plenário, zoom, luz).
   */
  const MATCH_MAX_DIST = 0.68;
  const MATCH_AMBIGUITY_MARGIN = 0.1;

  const DETECTOR_PHOTO = { inputSize: 512, scoreThreshold: 0.38 };
  const DETECTOR_VIDEO = { inputSize: 416, scoreThreshold: 0.32 };

  function detectorOptionsPhoto() {
    return new faceapi.TinyFaceDetectorOptions(DETECTOR_PHOTO);
  }

  function detectorOptionsVideo() {
    return new faceapi.TinyFaceDetectorOptions(DETECTOR_VIDEO);
  }

  /** @type {{ id: number, nome: string, siglaPartido: string, siglaUf: string, urlFoto: string, descriptor: Float32Array }[]} */
  let gallery = [];
  let modelsReady = false;
  let cameraRunning = false;
  let rafId = 0;

  const el = {
    legislatura: document.getElementById("legislatura"),
    btnBuild: document.getElementById("btnBuild"),
    btnCamera: document.getElementById("btnCamera"),
    buildProgress: document.getElementById("buildProgress"),
    buildBar: document.getElementById("buildBar"),
    buildText: document.getElementById("buildText"),
    status: document.getElementById("status"),
    viewer: document.getElementById("viewer"),
    videoWrap: document.getElementById("videoWrap"),
    video: document.getElementById("video"),
    overlay: document.getElementById("overlay"),
    zoomSlider: document.getElementById("videoZoom"),
    zoomNote: document.getElementById("zoomNote"),
    zoomLabel: document.getElementById("zoomLabel"),
    zoomHintMin: document.getElementById("zoomHintMin"),
    zoomHintMax: document.getElementById("zoomHintMax"),
    matchCard: document.getElementById("matchCard"),
    photoInput: document.getElementById("photoInput"),
    btnPhoto: document.getElementById("btnPhoto"),
    photoPreviewWrap: document.getElementById("photoPreviewWrap"),
    photoPreview: document.getElementById("photoPreview"),
    btnPhotoClear: document.getElementById("btnPhotoClear"),
  };

  function setStatus(text, kind) {
    el.status.textContent = text || "";
    el.status.className = "status" + (kind ? " status--" + kind : "");
  }

  if (typeof faceapi === "undefined" || typeof tf === "undefined") {
    if (typeof showCdnBlocked === "function") {
      showCdnBlocked();
    }
    setStatus(
      "TensorFlow ou face-api não carregaram. Rede corporativa costuma bloquear cdn.jsdelivr.net.",
      "err"
    );
    el.btnBuild.disabled = true;
    el.btnCamera.disabled = true;
    if (el.btnPhoto) el.btnPhoto.disabled = true;
    return;
  }

  var lastPhotoObjectUrl = null;

  function matchCardDefaultHtml() {
    return (
      '<div class="match-card__empty">' +
      "Use a câmera abaixo ou «Escolher foto e identificar» no painel." +
      "</div>"
    );
  }

  function showRecognitionPanel() {
    if (el.viewer) el.viewer.hidden = false;
  }

  function revokePhotoPreview() {
    if (lastPhotoObjectUrl) {
      try {
        URL.revokeObjectURL(lastPhotoObjectUrl);
      } catch (_) {}
      lastPhotoObjectUrl = null;
    }
    if (el.photoPreview) el.photoPreview.removeAttribute("src");
  }

  function clearPhotoSelection() {
    revokePhotoPreview();
    if (el.photoPreviewWrap) el.photoPreviewWrap.hidden = true;
    if (el.photoInput) el.photoInput.value = "";
    if (el.matchCard) el.matchCard.innerHTML = matchCardDefaultHtml();
  }

  function faceBoxArea(f) {
    var b = f.detection && f.detection.box ? f.detection.box : f.box;
    if (!b) return 0;
    return b.width * b.height;
  }

  function downscaleIfNeeded(img, maxSide) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) return img;
    if (w <= maxSide && h <= maxSide) return img;
    var scale = maxSide / Math.max(w, h);
    var cw = Math.round(w * scale);
    var ch = Math.round(h * scale);
    var c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    var ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, cw, ch);
    return c;
  }

  async function descriptorFromUserImage(source) {
    var det = await faceapi
      .detectSingleFace(source, detectorOptionsPhoto())
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (det && det.descriptor) return det;
    var all = await faceapi
      .detectAllFaces(source, detectorOptionsPhoto())
      .withFaceLandmarks()
      .withFaceDescriptors();
    if (!all || !all.length) return null;
    var best = all[0];
    var bestA = faceBoxArea(best);
    for (var i = 1; i < all.length; i++) {
      var a = faceBoxArea(all[i]);
      if (a > bestA) {
        best = all[i];
        bestA = a;
      }
    }
    return best && best.descriptor ? best : null;
  }

  function proxiedPhotoUrl(urlFoto) {
    return "/proxy-image?url=" + encodeURIComponent(urlFoto);
  }

  function hashIds(ids) {
    const s = ids.slice().sort((a, b) => a - b).join(",");
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const r = tx.objectStore(STORE).get(key);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => resolve(r.result);
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).put(value, key);
    });
  }

  async function fetchLegislaturas() {
    const r = await fetchApiV2("/legislaturas?itens=2&ordem=DESC");
    const j = await r.json();
    const lista = (j.dados || []).slice(0, 2);
    const rotulos = ["atual", "anterior"];
    el.legislatura.innerHTML = "";
    for (var i = 0; i < lista.length; i++) {
      const L = lista[i];
      const opt = document.createElement("option");
      opt.value = String(L.id);
      opt.textContent =
        "Legislatura " +
        L.id +
        " (" +
        rotulos[i] +
        ") — " +
        L.dataInicio +
        " a " +
        L.dataFim;
      el.legislatura.appendChild(opt);
    }
  }

  async function fetchDeputados(legId) {
    const all = [];
    let pagina = 1;
    while (true) {
      const pathQ =
        "/deputados?idLegislatura=" +
        legId +
        "&itens=100&pagina=" +
        pagina +
        "&ordenarPor=nome";
      const r = await fetchApiV2(pathQ);
      const j = await r.json();
      all.push.apply(all, j.dados);
      const next = j.links && j.links.find(function (l) {
        return l.rel === "next";
      });
      if (!next) break;
      pagina++;
    }
    return all;
  }

  async function ensureTf() {
    if (typeof tf === "undefined") return;
    try {
      await tf.setBackend("webgl");
      await tf.ready();
    } catch {
      try {
        await tf.setBackend("cpu");
        await tf.ready();
      } catch (_) {}
    }
  }

  async function ensureModels() {
    if (modelsReady) return;
    await ensureTf();
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    modelsReady = true;
  }

  async function descriptorFromUrl(urlFoto) {
    const src = proxiedPhotoUrl(urlFoto);
    const img = await faceapi.fetchImage(src);
    const det = await faceapi
      .detectSingleFace(img, detectorOptionsPhoto())
      .withFaceLandmarks()
      .withFaceDescriptor();
    return det ? det.descriptor : null;
  }

  async function mapPool(items, size, fn) {
    const out = new Array(items.length);
    let ix = 0;
    async function worker() {
      while (true) {
        const i = ix++;
        if (i >= items.length) break;
        out[i] = await fn(items[i], i);
      }
    }
    const n = Math.min(size, items.length);
    await Promise.all(Array.from({ length: n }, worker));
    return out;
  }

  function cacheKey(legId, idsHash) {
    return "gallery-" + legId + "-" + idsHash;
  }

  async function buildGallery(legId, deputies, onProgress) {
    const ids = deputies.map(function (d) {
      return d.id;
    });
    const h = hashIds(ids);
    const key = cacheKey(legId, h);
    const cached = await idbGet(key);
    if (cached && cached.items && cached.items.length) {
      gallery = cached.items.map(function (row) {
        return {
          id: row.id,
          nome: row.nome,
          siglaPartido: row.siglaPartido,
          siglaUf: row.siglaUf,
          urlFoto: row.urlFoto,
          descriptor: new Float32Array(row.descriptor),
        };
      });
      onProgress(1, gallery.length, gallery.length);
      return { fromCache: true, key: key };
    }

    const withPhoto = deputies.filter(function (d) {
      return d.urlFoto && String(d.urlFoto).includes("bandep/");
    });
    let done = 0;
    const total = withPhoto.length;

    const rows = await mapPool(withPhoto, POOL, async function (d) {
      let desc = null;
      try {
        desc = await descriptorFromUrl(d.urlFoto);
      } catch (_) {
        desc = null;
      }
      done++;
      onProgress(done / total, done, total);
      if (!desc) return null;
      return {
        id: d.id,
        nome: d.nome,
        siglaPartido: d.siglaPartido || "",
        siglaUf: d.siglaUf || "",
        urlFoto: d.urlFoto,
        descriptor: desc,
      };
    });

    gallery = rows.filter(Boolean);
    const serial = gallery.map(function (g) {
      return {
        id: g.id,
        nome: g.nome,
        siglaPartido: g.siglaPartido,
        siglaUf: g.siglaUf,
        urlFoto: g.urlFoto,
        descriptor: Array.from(g.descriptor),
      };
    });
    await idbSet(key, { legId: legId, idsHash: h, builtAt: Date.now(), items: serial });
    return { fromCache: false, key: key };
  }

  function bestMatch(queryDescriptor) {
    if (!gallery.length || !queryDescriptor) return null;
    let bestI = -1;
    let bestD = Infinity;
    let second = Infinity;
    for (let i = 0; i < gallery.length; i++) {
      const d = faceapi.euclideanDistance(queryDescriptor, gallery[i].descriptor);
      if (d < bestD) {
        second = bestD;
        bestD = d;
        bestI = i;
      } else if (d < second) {
        second = d;
      }
    }
    return { index: bestI, distance: bestD, second: second };
  }

  function confidenceClass(dist) {
    if (dist < MATCH_MAX_DIST * 0.62) return "high";
    if (dist < MATCH_MAX_DIST * 0.82) return "mid";
    return "low";
  }

  function formatConfidence(dist) {
    var scale = MATCH_MAX_DIST * 1.12;
    var pct = Math.max(0, Math.min(100, Math.round((1 - dist / scale) * 100)));
    return pct + "% confiança estimada";
  }

  function renderMatch(meta, dist, ambiguous) {
    if (!meta || dist > MATCH_MAX_DIST) {
      el.matchCard.innerHTML =
        '<div class="match-card__empty">Rosto não identificado entre os deputados desta legislatura. Aproxime-se, melhore a luz ou tente outro ângulo.</div>';
      return;
    }
    var cls = confidenceClass(dist);
    var amb =
      ambiguous && dist < MATCH_MAX_DIST * 0.88
        ? '<p class="match-result__sub" style="color:var(--warn)">Possível ambiguidade com outro deputado.</p>'
        : "";
    el.matchCard.innerHTML =
      '<div class="match-result">' +
      '<img src="' +
      proxiedPhotoUrl(meta.urlFoto) +
      '" alt="" width="88" height="110" loading="lazy" />' +
      '<div class="match-result__meta">' +
      "<h2 class=\"match-result__name\">" +
      escapeHtml(meta.nome) +
      "</h2>" +
      '<p class="match-result__sub">' +
      escapeHtml(meta.siglaPartido + " — " + meta.siglaUf) +
      "</p>" +
      '<p class="match-result__conf match-result__conf--' +
      cls +
      '">' +
      escapeHtml(formatConfidence(dist)) +
      "</p>" +
      amb +
      "</div></div>";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var lastMatchTs = 0;
  async function onVideoFrame() {
    if (!cameraRunning) return;
    var now = performance.now();
    if (now - lastMatchTs < 280) {
      rafId = requestAnimationFrame(onVideoFrame);
      return;
    }
    lastMatchTs = now;
    try {
      var det = await faceapi
        .detectSingleFace(el.video, detectorOptionsVideo())
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!det) {
        el.matchCard.innerHTML =
          '<div class="match-card__empty">Nenhum rosto detectado. Centralize o rosto na imagem.</div>';
      } else {
        var m = bestMatch(det.descriptor);
        if (!m || m.index < 0) {
          renderMatch(null, 1);
        } else {
          var ambiguous = m.second < m.distance + MATCH_AMBIGUITY_MARGIN;
          renderMatch(gallery[m.index], m.distance, ambiguous);
        }
      }
    } catch (_) {
      setStatus("Erro na detecção. Tente recarregar a página.", "err");
    }
    rafId = requestAnimationFrame(onVideoFrame);
  }

  var pinchStartDist = 0;
  var pinchStartZoom = 1;
  var zoomModeHardware = false;
  var zoomHwMin = 1;
  var zoomHwMax = 3;
  /** Zoom só na tela quando o browser não expõe zoom da câmara (plenários amplos). */
  var ZOOM_SOFT_MAX = 5;

  function touchPinchDist(t0, t1) {
    var dx = t0.clientX - t1.clientX;
    var dy = t0.clientY - t1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function readSliderZoom() {
    if (!el.zoomSlider) return 1;
    return parseFloat(el.zoomSlider.value);
  }

  function clampToSliderRange(v) {
    if (!el.zoomSlider) return v;
    var mn = parseFloat(el.zoomSlider.min);
    var mx = parseFloat(el.zoomSlider.max);
    if (v < mn) return mn;
    if (v > mx) return mx;
    return v;
  }

  async function tryBoostVideoResolution(track) {
    if (!track || typeof track.getCapabilities !== "function") return;
    try {
      var caps = track.getCapabilities();
      if (!caps.width || !caps.height) return;
      var w = Math.min(caps.width.max || 1920, 2560);
      var h = Math.min(caps.height.max || 1080, 1440);
      if (w < 640) return;
      await track.applyConstraints({
        width: { ideal: w },
        height: { ideal: h },
      });
    } catch (_) {}
  }

  function configureZoomUI(track) {
    if (!el.zoomSlider || !track || typeof track.getCapabilities !== "function") return;
    var caps = track.getCapabilities();
    var zcap = caps && caps.zoom;
    var hasUsableZoom =
      zcap && typeof zcap.min === "number" && typeof zcap.max === "number" && zcap.max > zcap.min + 0.0001;

    if (hasUsableZoom) {
      zoomModeHardware = true;
      zoomHwMin = zcap.min;
      zoomHwMax = zcap.max;
      var step = zcap.step;
      if (!step || step <= 0) {
        step = Math.max(0.001, (zoomHwMax - zoomHwMin) / 100);
      }
      el.zoomSlider.min = String(zoomHwMin);
      el.zoomSlider.max = String(zoomHwMax);
      el.zoomSlider.step = String(step);
      var settings = track.getSettings && track.getSettings();
      var cur =
        settings && typeof settings.zoom === "number" ? settings.zoom : zoomHwMin;
      cur = Math.min(zoomHwMax, Math.max(zoomHwMin, cur));
      el.zoomSlider.value = String(cur);
      if (el.zoomLabel) el.zoomLabel.textContent = "Zoom da câmara (qualidade preservada)";
      if (el.zoomHintMin) el.zoomHintMin.textContent = "min";
      if (el.zoomHintMax) el.zoomHintMax.textContent = "máx";
      if (el.zoomNote) {
        el.zoomNote.textContent =
          "Usa o zoom real da lente/sensor — podes ir ao máximo sem o borrão do zoom só na tela.";
      }
    } else {
      zoomModeHardware = false;
      zoomHwMin = 1;
      zoomHwMax = ZOOM_SOFT_MAX;
      el.zoomSlider.min = "1";
      el.zoomSlider.max = String(ZOOM_SOFT_MAX);
      el.zoomSlider.step = "0.05";
      el.zoomSlider.value = "1";
      if (el.zoomLabel) el.zoomLabel.textContent = "Zoom (só tela)";
      if (el.zoomHintMin) el.zoomHintMin.textContent = "1×";
      if (el.zoomHintMax) el.zoomHintMax.textContent = String(ZOOM_SOFT_MAX).replace(".", ",") + "×";
      if (el.zoomNote) {
        el.zoomNote.textContent =
          "Este aparelho/browser não expõe zoom óptico na Web: o deslize amplia a imagem no ecrã (perde nitidez no máximo). Para melhor resultado, aproxime o telemóvel ou use Chrome em Android com câmara traseira, se disponível.";
      }
    }
  }

  async function applyVideoZoom(level) {
    if (!el.video || !el.video.srcObject) return;
    var v = parseFloat(level);
    v = clampToSliderRange(v);
    var stream = el.video.srcObject;
    var track = stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track) return;

    if (zoomModeHardware) {
      try {
        if (typeof track.applyConstraints === "function") {
          try {
            await track.applyConstraints({ zoom: v });
          } catch (_) {
            await track.applyConstraints({ advanced: [{ zoom: v }] });
          }
        }
      } catch (_) {}
      el.video.style.transform = "scaleX(-1) scale(1)";
    } else {
      el.video.style.transform = "scaleX(-1) scale(" + v + ")";
    }
  }

  async function startCamera() {
    if (!gallery.length) {
      setStatus("Prepare o índice facial antes de usar a câmera.", "warn");
      return;
    }
    clearPhotoSelection();
    if (!window.isSecureContext) {
      setStatus(
        "A câmera exige HTTPS (ou localhost). Use um túnel seguro ou publique o app com TLS.",
        "err"
      );
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Este navegador não expõe getUserMedia.", "err");
      return;
    }
    await ensureModels();
    var stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
    } catch (_) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      } catch (e2) {
        setStatus("Permissão da câmera negada ou indisponível.", "err");
        return;
      }
    }
    el.video.srcObject = stream;
    await el.video.play();
    var vtrack = stream.getVideoTracks()[0];
    await tryBoostVideoResolution(vtrack);
    configureZoomUI(vtrack);
    el.viewer.hidden = false;
    cameraRunning = true;
    await applyVideoZoom(readSliderZoom());
    el.zoomSlider &&
      el.zoomSlider.setAttribute("aria-valuetext", "Zoom " + readSliderZoom().toFixed(2));
    setStatus("Câmera ativa. Resultado em cima; pinça ou deslize para zoom.", "ok");
    rafId = requestAnimationFrame(onVideoFrame);
  }

  function stopCamera() {
    cameraRunning = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    var stream = el.video.srcObject;
    if (stream && stream.getTracks) {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
    }
    el.video.srcObject = null;
    el.video.style.transform = "scaleX(-1) scale(1)";
    if (el.zoomSlider) {
      el.zoomSlider.min = "1";
      el.zoomSlider.max = String(ZOOM_SOFT_MAX);
      el.zoomSlider.step = "0.05";
      el.zoomSlider.value = "1";
      el.zoomSlider.setAttribute("aria-valuetext", "Zoom");
    }
    if (el.zoomLabel) el.zoomLabel.textContent = "Zoom";
    if (el.zoomHintMin) el.zoomHintMin.textContent = "−";
    if (el.zoomHintMax) el.zoomHintMax.textContent = "+";
    if (el.zoomNote) el.zoomNote.textContent = "Ajuste o zoom após iniciar a câmara.";
    if (el.btnCamera) el.btnCamera.textContent = "Iniciar câmera";
  }

  if (el.zoomSlider) {
    el.zoomSlider.addEventListener("input", function () {
      if (!cameraRunning) return;
      var v = readSliderZoom();
      el.zoomSlider.setAttribute(
        "aria-valuetext",
        zoomModeHardware ? "Zoom câmara " + v.toFixed(2) : "Zoom tela " + v.toFixed(2)
      );
      applyVideoZoom(v);
    });
  }

  if (el.videoWrap) {
    el.videoWrap.addEventListener(
      "touchstart",
      function (ev) {
        if (ev.touches.length === 2) {
          pinchStartDist = touchPinchDist(ev.touches[0], ev.touches[1]);
          pinchStartZoom = el.zoomSlider ? parseFloat(el.zoomSlider.value) : 1;
        }
      },
      { passive: true }
    );
    el.videoWrap.addEventListener(
      "touchmove",
      function (ev) {
        if (ev.touches.length === 2 && pinchStartDist > 10 && el.zoomSlider) {
          var d = touchPinchDist(ev.touches[0], ev.touches[1]);
          var ratio = d / pinchStartDist;
          var nv = pinchStartZoom * ratio;
          nv = clampToSliderRange(nv);
          el.zoomSlider.value = String(nv);
          el.zoomSlider.setAttribute(
            "aria-valuetext",
            zoomModeHardware ? "Zoom câmara " + nv.toFixed(2) : "Zoom tela " + nv.toFixed(2)
          );
          applyVideoZoom(nv);
          ev.preventDefault();
        }
      },
      { passive: false }
    );
    el.videoWrap.addEventListener(
      "touchend",
      function (ev) {
        if (ev.touches.length < 2) pinchStartDist = 0;
      },
      { passive: true }
    );
  }

  el.btnBuild.addEventListener("click", async function () {
    if (typeof faceapi === "undefined") {
      setStatus("Biblioteca face-api não carregou. Verifique a rede.", "err");
      return;
    }
    if (typeof location !== "undefined" && location.protocol === "file:") {
      setStatus(
        "Não abra o index.html diretamente (protocolo file://). Inicie o servidor — npm start, iniciar-servidor.cmd ou servidor.ps1 — e use http://127.0.0.1:3847/ para o proxy das fotos funcionar.",
        "err"
      );
      return;
    }
    el.btnBuild.disabled = true;
    el.btnCamera.disabled = true;
    if (el.btnPhoto) el.btnPhoto.disabled = true;
    stopCamera();
    el.buildProgress.hidden = false;
    el.buildBar.style.width = "0%";
    el.buildText.textContent = "0%";
    setStatus("Carregando modelos e lista de deputados…");
    try {
      try {
        await ensureModels();
      } catch (e) {
        console.error(e);
        var m0 = e && e.message ? e.message : String(e);
        if (m0 === "Failed to fetch") {
          m0 =
            "Falha ao carregar os modelos de rosto (jsDelivr). Rede ou firewall institucional pode bloquear o CDN; tente outra rede, desative bloqueadores ou outro navegador.";
        }
        setStatus(m0, "err");
        return;
      }
      var legId = parseInt(el.legislatura.value, 10);
      var deputies = await fetchDeputados(legId);
      if (!deputies.length) {
        setStatus("Nenhum deputado retornado para esta legislatura.", "warn");
        return;
      }
      setStatus("Extraindo rostos das fotos oficiais (pode demorar)…");
      var result = await buildGallery(legId, deputies, function (frac, done, total) {
        var p = Math.round(frac * 100);
        el.buildBar.style.width = p + "%";
        el.buildText.textContent = p + "% (" + done + "/" + total + ")";
      });
      el.btnCamera.disabled = gallery.length === 0;
      if (el.btnPhoto) el.btnPhoto.disabled = gallery.length === 0;
      if (gallery.length > 0) {
        showRecognitionPanel();
      } else if (el.viewer) {
        el.viewer.hidden = true;
      }
      setStatus(
        (result.fromCache ? "Índice carregado do armazenamento local. " : "Índice preparado. ") +
          gallery.length +
          " deputados com rosto detectável na foto oficial." +
          (gallery.length === 0 ? " Verifique o proxy de imagens (servidor npm start)." : ""),
        gallery.length ? "ok" : "warn"
      );
    } catch (e) {
      console.error(e);
      var msg = e && e.message ? e.message : String(e);
      if (msg === "Failed to fetch") {
        msg =
          "Falha de rede (Failed to fetch). Se estiver no celular, tente Wi‑Fi, desligar VPN ou bloqueador de anúncios; no PC confirme npm start ou deploy com Node (não site estático).";
      }
      setStatus(
        msg ||
          "Falha ao montar o índice. Use o servidor com Node (proxy /dados-abertos e /proxy-image) ou verifique a rede.",
        "err"
      );
    } finally {
      el.btnBuild.disabled = false;
      el.buildProgress.hidden = true;
    }
  });

  el.btnCamera.addEventListener("click", async function () {
    if (cameraRunning) {
      stopCamera();
      el.btnCamera.textContent = "Iniciar câmera";
      setStatus("Câmera parada.");
      return;
    }
    el.btnCamera.disabled = true;
    await startCamera();
    el.btnCamera.disabled = false;
    el.btnCamera.textContent = "Parar câmera";
  });

  if (el.btnPhoto && el.photoInput) {
    el.btnPhoto.addEventListener("click", function () {
      if (!gallery.length) {
        setStatus("Prepare o índice facial antes de identificar.", "warn");
        return;
      }
      el.photoInput.click();
    });
  }

  if (el.photoInput) {
    el.photoInput.addEventListener("change", function () {
      var file = el.photoInput.files && el.photoInput.files[0];
      if (!file || !file.type || file.type.indexOf("image/") !== 0) {
        return;
      }
      stopCamera();
      if (el.btnCamera) el.btnCamera.textContent = "Iniciar câmera";
      revokePhotoPreview();
      lastPhotoObjectUrl = URL.createObjectURL(file);
      el.photoPreview.src = lastPhotoObjectUrl;
      if (el.photoPreviewWrap) el.photoPreviewWrap.hidden = false;
      showRecognitionPanel();

      function run() {
        ensureModels()
          .then(function () {
            setStatus("A analisar rosto na foto…");
            var source = downscaleIfNeeded(el.photoPreview, 1024);
            return descriptorFromUserImage(source);
          })
          .then(function (det) {
            if (!det || !det.descriptor) {
              el.matchCard.innerHTML =
                '<div class="match-card__empty">Nenhum rosto detetável nesta foto. Tente outra mais nítida, com boa luz ou mais de perto.</div>';
              setStatus("Sem rosto identificável na imagem.", "warn");
              return;
            }
            var m = bestMatch(det.descriptor);
            if (!m || m.index < 0) {
              renderMatch(null, 1);
              setStatus("Rosto na foto não corresponde a um deputado do índice com confiança suficiente.", "warn");
              return;
            }
            var ambiguous = m.second < m.distance + MATCH_AMBIGUITY_MARGIN;
            renderMatch(gallery[m.index], m.distance, ambiguous);
            setStatus("Identificação a partir da foto concluída.", "ok");
          })
          .catch(function (e) {
            console.error(e);
            setStatus(
              (e && e.message) || "Erro ao processar a foto. Tente outra imagem ou recarregue a página.",
              "err"
            );
          })
          .finally(function () {
            if (el.photoInput) el.photoInput.value = "";
          });
      }

      if (el.photoPreview.complete && el.photoPreview.naturalWidth > 0) {
        run();
      } else {
        el.photoPreview.onload = function () {
          el.photoPreview.onload = null;
          run();
        };
        el.photoPreview.onerror = function () {
          el.photoPreview.onerror = null;
          setStatus("Não foi possível carregar a imagem escolhida.", "err");
          clearPhotoSelection();
        };
      }
    });
  }

  if (el.btnPhotoClear) {
    el.btnPhotoClear.addEventListener("click", function () {
      clearPhotoSelection();
      setStatus("Foto removida. Use a câmera ou escolha outra imagem.");
    });
  }

  fetchLegislaturas()
    .then(function () {
      setStatus("Escolha a legislatura e toque em Preparar índice facial.");
    })
    .catch(function (e) {
      console.error(e);
      setStatus("Não foi possível carregar legislaturas. Verifique a conexão.", "err");
    });
})();
