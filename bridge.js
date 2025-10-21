// (function () {
//   if (window.__tikzjaxLoaded) return;
//   const url = window.__TIKZJAX_URL__;
//   if (!url) return; // 안전장치
//
//   const s = document.createElement("script");
//   s.id = "__tikzjax_script";
//   s.src = url; // ← chrome.runtime.getURL 사용 제거
//   s.onload = () => { window.__tikzjaxLoaded = true; };
//   (document.head || document.documentElement).appendChild(s);
//
//   window.addEventListener("message", (ev) => {
//     if (ev?.data !== "tikz:process") return;
//     try {
//       if (window.tikzjax?.process) window.tikzjax.process();
//       else if (window.TikzJax?.typeset) window.TikzJax.typeset();
//     } catch (e) {
//       console.warn("[TikZ bridge] process error:", e);
//     }
//   });
// })();
