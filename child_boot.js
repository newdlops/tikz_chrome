// child_boot.js
(() => {
  const EXT_ORIGIN  = location.origin; // chrome-extension://<ID>
  const S3_BASE     = 'https://s3.us-east-2.amazonaws.com/tikzjax.com';
  const LOCAL_BASE  = new URL('vendor/tikzjax/', location.href).toString();

  const postUp = (msg) => parent.postMessage({ type: "CHILD_LOG", msg }, EXT_ORIGIN);
  const ready  = () => parent.postMessage({ type: "CHILD_READY" }, EXT_ORIGIN);
  const done   = (ok, data) => parent.postMessage({ type: "CHILD_DONE", ok, ...(ok?{svg:data}:{error:data}) }, EXT_ORIGIN);

  // ---- UTF-8 안전 btoa 폴리필 (tikzjax가 btoa를 쓰는 경우 대비) ----
  (function patchBtoaUtf8(){
    const orig = window.btoa;
    try {
      // 테스트: 유니코드 포함 문자열이 예외를 던지면 폴리필 적용
      orig("✓");
      // 위 호출이 통과해도, 라틴1 외 문자열에서 깨질 수 있어 강제 폴리필 권장
    } catch {}
    window.btoa = (str) => {
      // UTF-8 → binary string → base64
      const bytes = new TextEncoder().encode(String(str));
      let bin = "";
      for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
      return orig(bin);
    };
    postUp("btoa patched to UTF-8 safe");
  })();

  // ---- fetch/XHR/Worker 리라이트 (S3 → 확장 로컬) ----
  (function patchFetchXHRWorker(){
    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (url && url.startsWith(S3_BASE)) {
        const local = url.replace(S3_BASE, LOCAL_BASE);
        postUp(`fetch rewrite: ${url} → ${local}`);
        return origFetch(local, init);
      }
      return origFetch(input, init);
    };

    const OX = window.XMLHttpRequest;
    if (OX) {
      window.XMLHttpRequest = function(){
        const x = new OX();
        const o = x.open;
        x.open = function(m, u, ...r){
          let target = u;
          if (typeof u === 'string' && u.startsWith(S3_BASE)) {
            const local = u.replace(S3_BASE, LOCAL_BASE);
            postUp(`XHR rewrite: ${u} → ${local}`);
            target = local;
          }
          return o.call(this, m, target, ...r);
        };
        return x;
      };
    }

    const OW = window.Worker;
    if (OW) {
      window.Worker = function(url, options){
        if (options && options.type === 'module') {
          postUp(`module Worker passthrough: ${url}`);
          return new OW(url, options); // DNR에 맡김
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
        const w = new OW(blobURL, { type: 'classic' });
        URL.revokeObjectURL(blobURL);
        postUp(`Worker wrapped for: ${url}`);
        return w;
      };
    }
  })();

  // ---- Emscripten Module 훅 (wasm 경로 고정 + 로그) ----
  window.Module = {
    locateFile: (path) => LOCAL_BASE + path,
    print:    (...a) => postUp(`Module.print: ${a.join(' ')}`),
    printErr: (...a) => postUp(`Module.printErr: ${a.join(' ')}`),
    onAbort:  (w)   => postUp(`Module.abort: ${w}`)
  };

  // ---- 렌더 시작 핸들러: 부모가 TikZ 코드 보내면 DOM에 세팅 후 tikzjax 로드 ----
  async function startRender(code) {
    postUp("startRender");

    // 문서 클린업
    document.querySelectorAll("script[type='text/tikz'], svg").forEach(n => n.remove());

    // TikZ 스크립트 (비실행 타입이라 CSP 문제 없음)
    const tikz = document.createElement("script");
    tikz.type = "text/tikz";
    tikz.textContent = String(code);
    document.body.appendChild(tikz);

    // tikzjax.js 외부 파일 로드 (인라인 금지)
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = LOCAL_BASE + "tikzjax.js" + `?t=${Date.now()}`;
      s.onload = res;
      s.onerror = () => rej(new Error("tikzjax load error"));
      document.body.appendChild(s);
    });
    postUp("tikzjax loaded; waiting for SVG");

    // SVG 나오길 대기
    const t0 = Date.now();
    const poll = () => {
      const svg = document.querySelector("svg");
      if (svg) {
        postUp(`SVG ready in ${Date.now() - t0}ms`);
        done(true, svg.outerHTML);
      } else if (Date.now() - t0 > 20000) {
        postUp("timeout waiting for SVG");
        done(false, "timeout");
      } else {
        setTimeout(poll, 120);
      }
    };
    poll();
  }

  // 부모(sandbox)에서 렌더 요청 수신
  window.addEventListener("message", (ev) => {
    if (ev.origin !== EXT_ORIGIN) return;
    const { type, code } = ev.data || {};
    if (type === "CHILD_RENDER") startRender(code).catch(e => done(false, e?.message || e));
  });

  // 준비 완료 통지
  ready();
})();
