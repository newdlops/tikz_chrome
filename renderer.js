// renderer.js
(() => {
  const CONF = (window && window.__CHATGPT_TIKZ_CONF__) || {};
  const FRAME_URL = CONF.frameUrl;
  const FONT_CSS_URL = CONF.fontCssUrl;
  if (!FRAME_URL || !FONT_CSS_URL) {
    console.error("[ChatGPT TikZ] 구성값 누락");
    return;
  }
  const FRAME_ORIGIN = new URL(FRAME_URL).origin;

  // 1) 메인 문서 폰트
  if (!document.getElementById("__chatgpt_tikz_font_css__")) {
    const link = document.createElement("link");
    link.id = "__chatgpt_tikz_font_css__";
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = FONT_CSS_URL;
    (document.head || document.documentElement).appendChild(link);
  }

  // 2) 숨은 iframe 준비
  let iframe = document.getElementById("__chatgpt_tikz_iframe__");
  let frameReady = false;

  const ensureIframeReady = () => new Promise((resolve) => {
    if (iframe && iframe.contentWindow && frameReady) return resolve();
    if (!iframe) {
      iframe = document.createElement("iframe");
      iframe.id = "__chatgpt_tikz_iframe__";
      Object.assign(iframe.style, {
        position: "absolute", left: "-9999px", width: "0", height: "0",
        border: "0", visibility: "hidden"
      });
      document.documentElement.appendChild(iframe);
    }
    iframe.onload = () => { frameReady = true; resolve(); };
    iframe.src = FRAME_URL; // 로드 완료되면 확장 오리진
  });

  // 3) 대상 수집
  const isTikz = (t) => /\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/.test(t || "");
  const blocks = Array.from(document.querySelectorAll("pre code"));
  const targets = blocks
  .map(code => ({ pre: code.closest("pre"), text: code.textContent }))
  .filter(x => x.pre && isTikz(x.text) && !x.pre.dataset.tikzRendered);

  if (targets.length === 0) {
    console.info("[ChatGPT TikZ] 렌더링할 TikZ 코드블럭이 없습니다.");
    return;
  }

  // 4) 메시지 브릿지 (큐 + 로그 표시)
  const reqQueue = [];
  let inflight = null;

  const send = (id, code) => {
    iframe.contentWindow.postMessage({ type: "RENDER_TIKZ", id, code }, FRAME_ORIGIN);
  };

  const kick = async () => {
    if (inflight || reqQueue.length === 0) return;
    await ensureIframeReady();
    inflight = reqQueue.shift();
    send(inflight.id, inflight.code);
  };

  // 코드블럭별 디버그 로그 영역 맵
  const logAreas = new Map(); // id -> <pre>

  const appendLog = (id, line) => {
    const area = logAreas.get(id);
    if (!area) return;
    const ts = new Date().toISOString().split("T")[1].replace("Z","");
    area.textContent += `[${ts}] ${line}\n`;
  };

  window.addEventListener("message", (ev) => {
    if (ev.origin !== FRAME_ORIGIN) return;

    const data = ev.data || {};
    // 디버그 로그 전달
    if (data.type === "SANDBOX_LOG" && data.id && data.msg) {
      appendLog(data.id, data.msg);
      return;
    }

    const { type, id, ok, svg, error } = data;
    if (type !== "SVG_RESULT" || !inflight || inflight.id !== id) return;

    const { outEl, dbgEl } = inflight;
    inflight = null;

    if (ok && svg) {
      outEl.innerHTML = svg;
      appendLog(id, "✅ SVG 렌더 성공");
    } else {
      outEl.textContent = "TikZ 렌더 실패: " + (error || "알 수 없는 오류");
      appendLog(id, `❌ 실패: ${error || "unknown"}`);
    }
    kick();
  });

  // 5) 각 블럭 UI + 큐 등록 (디버그 로그 UI 포함)
  targets.forEach(({ pre, text }, idx) => {
    pre.dataset.tikzRendered = "1";

    const container = document.createElement("div");
    container.style.margin = "0.5rem 0";

    const toolbar = document.createElement("div");
    Object.assign(toolbar.style, {
      display: "flex", gap: "8px", alignItems: "center", marginBottom: "4px"
    });

    const btn = document.createElement("button");
    btn.textContent = "원본 보기";
    Object.assign(btn.style, {
      padding: "2px 8px", border: "1px solid #ccc",
      borderRadius: "6px", cursor: "pointer"
    });

    const raw = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "원본 코드";
    raw.appendChild(sum);
    raw.appendChild(pre.cloneNode(true));
    raw.open = false;

    btn.addEventListener("click", () => {
      raw.open = !raw.open;
      btn.textContent = raw.open ? "렌더 보기" : "원본 보기";
    });

    const out = document.createElement("div");
    out.textContent = "렌더링 중…";

    // 디버그 로그 패널
    const dbgWrap = document.createElement("details");
    const dbgSum = document.createElement("summary");
    dbgSum.textContent = "디버그 로그";
    const dbgPre = document.createElement("pre");
    Object.assign(dbgPre.style, {
      background: "#f7f7f9", border: "1px solid #ddd",
      padding: "6px", borderRadius: "6px", whiteSpace: "pre-wrap"
    });
    dbgWrap.appendChild(dbgSum);
    dbgWrap.appendChild(dbgPre);

    toolbar.appendChild(btn);
    container.appendChild(toolbar);
    container.appendChild(out);
    container.appendChild(dbgWrap);
    pre.insertAdjacentElement("afterend", container);

    const id = `tikz_${Date.now()}_${idx}`;
    logAreas.set(id, dbgPre);
    appendLog(id, "🔧 요청 생성");

    reqQueue.push({ id, code: text, outEl: out, dbgEl: dbgPre });
  });

  // 6) 시작
  kick();
})();
