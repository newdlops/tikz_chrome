// sandbox_frame.js
(() => {
  let parentOrigin = null;   // 메인 페이지(ChatGPT) 오리진
  let currentId = null;

  const EXT_ORIGIN = location.origin; // chrome-extension://<ID>
  const CHILD_URL  = new URL("child_frame.html", location.href).toString();

  const postUp = (type, payload) => {
    if (!parentOrigin) return;
    parent.postMessage({ type, ...payload }, parentOrigin);
  };
  const postLog = (msg) => {
    console.log("[sandbox]", msg);
    postUp("SANDBOX_LOG", { id: currentId || "__boot__", msg });
  };

  // 메인에서 온 요청 수신
  window.addEventListener("message", async (ev) => {
    const { type, id, code } = ev.data || {};
    if (!type) return;

    if (!parentOrigin) parentOrigin = ev.origin;

    if (type === "RENDER_TIKZ" && id) {
      currentId = id;
      postLog("=== RENDER START ===");

      // 자식 프레임 생성 (확장 오리진 HTML, 인라인 없음)
      const child = document.createElement("iframe");
      Object.assign(child.style, {
        position: "absolute", left: "-9999px", width: "0", height: "0",
        border: "0", visibility: "hidden"
      });

      const finish = (ok, result) => {
        try { child.remove(); } catch {}
        postLog(`=== RENDER END (ok=${ok}) ===`);
        postUp("SVG_RESULT", { id, ok, ...(ok ? { svg: result } : { error: result }) });
        currentId = null;
      };

      // 자식이 보내는 로그/이벤트 중계
      const onChildMsg = (e) => {
        if (e.origin !== EXT_ORIGIN) return;
        const data = e.data || {};
        if (data.type === "CHILD_LOG") {
          postLog(`[child] ${data.msg}`);
        } else if (data.type === "CHILD_READY") {
          postLog("child ready");
          // child 준비 완료 → 렌더 시작
          child.contentWindow.postMessage({ type: "CHILD_RENDER", code }, EXT_ORIGIN);
        } else if (data.type === "CHILD_DONE") {
          window.removeEventListener("message", onChildMsg);
          if (data.ok) finish(true, data.svg);
          else finish(false, data.error || "timeout");
        }
      };
      window.addEventListener("message", onChildMsg);

      child.src = CHILD_URL;
      document.body.appendChild(child);
    }
  });
})();
