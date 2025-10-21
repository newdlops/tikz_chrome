// (function () {
//   // TikZ 후보 찾기
//   const blocks = Array.from(document.querySelectorAll("pre > code"))
//   .filter((c) => !c.closest("pre")?.dataset?.tikzRendered);
//
//   let found = 0;
//   for (const codeEl of blocks) {
//     const raw = codeEl.innerText || codeEl.textContent || "";
//     if (!/\\begin\{tikzpicture\}|\\begin\{tikzcd\}|(^|\\)tikz\b/.test(raw)) continue;
//
//     const pre = codeEl.closest("pre");
//     const out = document.createElement("div");
//     out.className = "tikz-render-container";
//     pre.insertAdjacentElement("afterend", out);
//
//     // 인라인 실행이 아니라 "데이터"를 담는 용도라 CSP의 inline JS 금지와 충돌 X
//     const script = document.createElement("script");
//     script.type = "text/tikz";
//     script.textContent = raw;
//     out.appendChild(script);
//
//     pre.dataset.tikzRendered = "1";
//     found++;
//   }
//
//   // 브리지에 "처리해!" 신호 (inline script 없이 호출)
//   if (found > 0) window.postMessage("tikz:process", "*");
// })();
