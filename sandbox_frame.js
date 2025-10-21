// sandbox_frame.js
(() => {
  // ------------- 설정 & 로그 브릿지 -------------
  const LOG_BUFFER = [];
  let parentOrigin = null; // 첫 메시지의 origin으로 설정
  let currentId = null;    // 현재 처리 중인 요청 ID

  const postLog = (msg) => {
    console.log("[sandbox]", msg);
    const payload = { type: "SANDBOX_LOG", id: currentId || "__boot__", msg };
    // parentOrigin이 정해지기 전에는 버퍼링
    if (!parentOrigin) { LOG_BUFFER.push(payload); return; }
    try { parent.postMessage(payload, parentOrigin); } catch {}
  };

  // ------------- S3 → 확장 로컬 리라이트 (fetch/XHR) -------------
  const S3_BASE = 'https://s3.us-east-2.amazonaws.com/tikzjax.com';
  const LOCAL_BASE = new URL('vendor/tikzjax/', location.href).toString();

  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (url && url.startsWith(S3_BASE)) {
      const local = url.replace(S3_BASE, LOCAL_BASE);
      postLog(`fetch rewrite: ${url} → ${local}`);
      return origFetch(local, init);
    }
    postLog(`fetch passthrough: ${url}`);
    return origFetch(input, init);
  };

  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    window.XMLHttpRequest = function WrappedXHR() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open;
      xhr.open = function(method, url, ...rest) {
        let u = url;
        if (typeof url === 'string' && url.startsWith(S3_BASE)) {
          const local = url.replace(S3_BASE, LOCAL_BASE);
          postLog(`XHR rewrite: ${url} → ${local}`);
          u = local;
        } else {
          postLog(`XHR passthrough: ${url}`);
        }
        return origOpen.call(this, method, u, ...rest);
      };
      return xhr;
    };
  }

  // ------------- Worker 래핑 (classic 전용) -------------
  const OrigWorker = window.Worker;
  if (OrigWorker) {
    window.Worker = function(url, options) {
      if (options && options.type === 'module') {
        postLog(`module Worker passthrough: ${url}`);
        return new OrigWorker(url, options); // DNR에 맡김
      }
      const absUrl = new URL(url, location.href).toString();
      const bootstrap = `
        (function(){
          const S3_BASE='${S3_BASE}';
          const LOCAL_BASE='${LOCAL_BASE}';
          const origFetch = self.fetch.bind(self);
          self.fetch = (input, init) => {
            const u = typeof input==='string' ? input : (input && input.url) || String(input);
            if (u && u.startsWith(S3_BASE)) {
              const l = u.replace(S3_BASE, LOCAL_BASE);
              try { console.log('[worker] fetch rewrite:', u, '→', l); } catch(e){}
              return origFetch(l, init);
            }
            return origFetch(input, init);
          };
          const OX = self.XMLHttpRequest;
          if (OX) {
            self.XMLHttpRequest = function(){
              const x = new OX();
              const o = x.open;
              x.open = function(m, u, ...r){
                let target=u;
                if (typeof u==='string' && u.startsWith(S3_BASE)){
                  const l = u.replace(S3_BASE, LOCAL_BASE);
                  try { console.log('[worker] XHR rewrite:', u, '→', l); } catch(e){}
                  target = l;
                }
                return o.call(this,m,target,...r);
              };
              return x;
            };
          }
          importScripts('${absUrl}');
        })();
      `;
      const blob = new Blob([bootstrap], { type: 'application/javascript' });
      const blobURL = URL.createObjectURL(blob);
      const w = new OrigWorker(blobURL, { type: 'classic' });
      URL.revokeObjectURL(blobURL);
      postLog(`Worker wrapped for: ${url}`);
      return w;
    };
  }

  // ------------- WASM 계측 (instantiateStreaming/instantiate 훅) -------------
  if (WebAssembly && WebAssembly.instantiateStreaming) {
    const origIS = WebAssembly.instantiateStreaming;
    WebAssembly.instantiateStreaming = async (source, importObject) => {
      postLog("WebAssembly.instantiateStreaming called");
      const resp = await source; // Response 또는 Promise<Response>
      try { postLog(`WASM response url: ${resp.url} (status ${resp.status})`); } catch {}
      try {
        const clone = resp.clone();
        const bytes = await clone.arrayBuffer();
        postLog(`WASM bytes length: ${bytes.byteLength}`);
      } catch (e) {
        postLog(`WASM arrayBuffer clone failed: ${e?.message || e}`);
      }
      return origIS(Promise.resolve(resp), importObject);
    };
  }
  if (WebAssembly && WebAssembly.instantiate) {
    const origI = WebAssembly.instantiate;
    WebAssembly.instantiate = async (bufferSource, importObject) => {
      if (bufferSource instanceof ArrayBuffer) {
        postLog(`WebAssembly.instantiate(ArrayBuffer) len=${bufferSource.byteLength}`);
      } else {
        postLog(`WebAssembly.instantiate(non-ArrayBuffer)`);
      }
      return origI(bufferSource, importObject);
    };
  }

  // ------------- 로컬 리소스 HEAD 사전 점검 -------------
  async function preflightHeadCheck() {
    const files = [
      "3f69afb974a1e83f66a36f7618f88a38c254034b.wasm",
      "b565ab0b474e8e557d954694b7379a57db669ac9.gz"
    ];
    for (const f of files) {
      const url = LOCAL_BASE + f;
      try {
        const r = await fetch(url, { method: "HEAD" });
        postLog(`HEAD ${f}: ${r.status} ${r.ok ? 'OK' : 'NG'} ct=${r.headers.get('content-type')}`);
      } catch (e) {
        postLog(`HEAD ${f} FAIL: ${e?.message || e}`);
      }
    }
  }

  // ------------- 안전한 script 삽입용 escape -------------
  const esc = (s) => String(s || "").replace(/<\/script/gi, "<\\/script");

  // ------------- 콜드 스타트 렌더 -------------
  const runOnce = (code) => new Promise((resolve) => {
    // 초기화
    document.body.querySelectorAll("script[type='text/tikz'], svg").forEach(n => n.remove());

    // Emscripten Module 훅 (print/err/locate)
    window.Module = {
      locateFile: (path) => new URL(`vendor/tikzjax/${path}`, location.href).toString(),
      print: (...a) => postLog(`Module.print: ${a.join(' ')}`),
      printErr: (...a) => postLog(`Module.printErr: ${a.join(' ')}`),
      onAbort: (w) => postLog(`Module.abort: ${w}`)
    };

    // TikZ 코드
    const tikz = document.createElement("script");
    tikz.type = "text/tikz";
    tikz.textContent = code;
    document.body.appendChild(tikz);

    // tikzjax 로드
    const s = document.createElement("script");
    s.src = "vendor/tikzjax/tikzjax.js" + `?t=${Date.now()}`;
    s.onload = () => {
      postLog("tikzjax.js loaded; waiting for SVG…");
      const t0 = Date.now();
      const poll = () => {
        const svg = document.querySelector("svg");
        if (svg) {
          postLog(`SVG ready in ${Date.now() - t0}ms`);
          return resolve({ ok: true, svg: svg.outerHTML });
        }
        if (Date.now() - t0 > 20000) {
          postLog("timeout waiting for SVG");
          return resolve({ ok: false, error: "timeout" });
        }
        setTimeout(poll, 100);
      };
      poll();
    };
    s.onerror = () => {
      postLog("tikzjax load error");
      resolve({ ok: false, error: "tikzjax load error" });
    };
    document.body.appendChild(s);
  });

  // ------------- 부모와 통신 -------------
  window.addEventListener("message", async (ev) => {
    const { type, id, code } = ev.data || {};
    if (!type) return;

    // 최초 메시지에서 부모 오리진을 확정하고, 버퍼 로그 방출
    if (!parentOrigin) {
      parentOrigin = ev.origin;
      for (const p of LOG_BUFFER) parent.postMessage(p, parentOrigin);
      LOG_BUFFER.length = 0;
    }

    if (type === "RENDER_TIKZ" && id) {
      currentId = id;
      postLog("=== RENDER START ===");
      await preflightHeadCheck();               // 로컬 파일 접근성 즉시 검증
      const result = await runOnce(esc(code));  // 콜드 스타트 렌더
      postLog(`=== RENDER END (ok=${result.ok}) ===`);
      parent.postMessage({ type: "SVG_RESULT", id, ...result }, parentOrigin);
      currentId = null;
    }
  });
})();
