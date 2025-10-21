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
    document.querySelectorAll("script[type='text/tikz'], .tikz-host, svg").forEach(n => n.remove());

    // 1) 포지셔닝 컨테이너(상대 좌표) 만들기
    const host = document.createElement("div");
    host.className = "tikz-host";
    // display:inline-block + position:relative 로, 안의 절대좌표 svg를 이 컨테이너 기준으로 묶음
    host.style.cssText = "position:relative; display:inline-block;";
    document.body.appendChild(host);

    // 2) TikZ 스크립트를 컨테이너 안에 넣기
    const tikz = document.createElement("script");
    tikz.type = "text/tikz";
    tikz.textContent = String(code);
    host.appendChild(tikz);

    // 3) tikzjax.js 로드 (외부 파일)
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = LOCAL_BASE + "tikzjax.js" + `?t=${Date.now()}`;
      s.onload = res;
      s.onerror = () => rej(new Error("tikzjax load error"));
      document.body.appendChild(s);
    });
    postUp("tikzjax loaded; waiting for SVG");

    // 4) SVG가 생길 때까지 대기 (컨테이너 내부에서만 검색)
    const t0 = Date.now();
    const poll = () => {
      const svg = host.querySelector("svg");
      if (svg) {
        // (A) 혹시 tikzjax가 svg에 absolute를 박아두면 컨테이너 기준으로 보이게 컨테이너 크기를 확정
        // 우선 getBoundingClientRect()로 실제 픽셀 크기 측정
        const rect = svg.getBoundingClientRect();
        // width/height가 0이면 속성에서 가져오거나 viewBox 사용
        let w = rect.width || parseFloat(svg.getAttribute("width")) || (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) || 0;
        let h = rect.height || parseFloat(svg.getAttribute("height")) || (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.height) || 0;
        if (w && h) {
          host.style.width = w + "px";
          host.style.height = h + "px";
        }

        // (B) 최후수단: svg가 꼭대기에 겹치면 absolute를 풀어 정상 흐름으로
        // (tikzjax 빌드에 따라 필요 없으면 자동으로 무시)
        if (getComputedStyle(svg).position === "absolute") {
          svg.style.position = "static";
          svg.style.left = "";
          svg.style.top = "";
        }

        postUp(`SVG ready in ${Date.now() - t0}ms`);

        // 5) 컨테이너 통째로 부모에 전달 (중요!)
        const wrapper = document.createElement("div");
        wrapper.className = "tikz-wrap";
        wrapper.style.cssText = "display:inline-block;"; // 레이아웃 안정화
        wrapper.appendChild(host.cloneNode(true)); // 컨테이너 + svg 복제
        return done(true, wrapper.innerHTML);
      }

      if (Date.now() - t0 > 20000) {
        postUp("timeout waiting for SVG");
        return done(false, "timeout");
      }
      setTimeout(poll, 120);
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
