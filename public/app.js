/* global faceapi, tf */
(function () {
  "use strict";

  const API = "https://dadosabertos.camara.leg.br/api/v2";
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";
  const DB_NAME = "camara-face-identifica-v1";
  const STORE = "gallery";
  const POOL = 4;

  function detectorOptionsPhoto() {
    return new faceapi.TinyFaceDetectorOptions({
      inputSize: 416,
      scoreThreshold: 0.45,
    });
  }

  function detectorOptionsVideo() {
    return new faceapi.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: 0.4,
    });
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
    video: document.getElementById("video"),
    overlay: document.getElementById("overlay"),
    matchCard: document.getElementById("matchCard"),
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
    return;
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
    const r = await fetch(API + "/legislaturas?itens=16&ordem=DESC");
    if (!r.ok) throw new Error("Falha ao carregar legislaturas.");
    const j = await r.json();
    el.legislatura.innerHTML = "";
    for (const L of j.dados) {
      const opt = document.createElement("option");
      opt.value = String(L.id);
      opt.textContent = "Legislatura " + L.id + " (" + L.dataInicio + " – " + L.dataFim + ")";
      el.legislatura.appendChild(opt);
    }
  }

  async function fetchDeputados(legId) {
    const all = [];
    let pagina = 1;
    while (true) {
      const url =
        API + "/deputados?idLegislatura=" + legId + "&itens=100&pagina=" + pagina + "&ordenarPor=nome";
      const r = await fetch(url);
      if (!r.ok) throw new Error("Falha ao listar deputados.");
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
    if (dist < 0.42) return "high";
    if (dist < 0.52) return "mid";
    return "low";
  }

  function formatConfidence(dist) {
    var pct = Math.max(0, Math.min(100, Math.round((1 - dist / 0.65) * 100)));
    return pct + "% confiança estimada";
  }

  function renderMatch(meta, dist, ambiguous) {
    if (!meta || dist > 0.62) {
      el.matchCard.innerHTML =
        '<div class="match-card__empty">Rosto não identificado entre os deputados desta legislatura. Aproxime-se, melhore a luz ou tente outro ângulo.</div>';
      return;
    }
    var cls = confidenceClass(dist);
    var amb =
      ambiguous && dist < 0.55
        ? '<p class="match-result__sub" style="color:var(--warn)">Possível ambiguidade com outro deputado.</p>'
        : "";
    el.matchCard.innerHTML =
      '<div class="match-result">' +
      '<img src="' +
      proxiedPhotoUrl(meta.urlFoto) +
      '" alt="" width="72" height="90" loading="lazy" />' +
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
          var ambiguous = m.second < m.distance + 0.08;
          renderMatch(gallery[m.index], m.distance, ambiguous);
        }
      }
    } catch (_) {
      setStatus("Erro na detecção. Tente recarregar a página.", "err");
    }
    rafId = requestAnimationFrame(onVideoFrame);
  }

  async function startCamera() {
    if (!gallery.length) {
      setStatus("Prepare o índice facial antes de usar a câmera.", "warn");
      return;
    }
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
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
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
    el.viewer.hidden = false;
    cameraRunning = true;
    setStatus("Câmera ativa. Aponte para um rosto.", "ok");
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
    el.viewer.hidden = true;
  }

  el.btnBuild.addEventListener("click", async function () {
    if (typeof faceapi === "undefined") {
      setStatus("Biblioteca face-api não carregou. Verifique a rede.", "err");
      return;
    }
    el.btnBuild.disabled = true;
    el.btnCamera.disabled = true;
    stopCamera();
    el.buildProgress.hidden = false;
    el.buildBar.style.width = "0%";
    el.buildText.textContent = "0%";
    setStatus("Carregando modelos e lista de deputados…");
    try {
      await ensureModels();
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
      setStatus(
        (result.fromCache ? "Índice carregado do armazenamento local. " : "Índice preparado. ") +
          gallery.length +
          " deputados com rosto detectável na foto oficial." +
          (gallery.length === 0 ? " Verifique o proxy de imagens (servidor npm start)." : ""),
        gallery.length ? "ok" : "warn"
      );
    } catch (e) {
      console.error(e);
      setStatus(
        e.message ||
          "Falha ao montar o índice. Confirme que está acessando pelo servidor (npm start) para o proxy das imagens.",
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

  fetchLegislaturas()
    .then(function () {
      setStatus("Escolha a legislatura e toque em Preparar índice facial.");
    })
    .catch(function (e) {
      console.error(e);
      setStatus("Não foi possível carregar legislaturas. Verifique a conexão.", "err");
    });
})();
