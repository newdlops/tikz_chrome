// background.js

async function installRedirectRule() {
  const id = chrome.runtime.id;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001],
      addRules: [{
        id: 1001,
        priority: 1,
        action: {
          type: "redirect",
          regexSubstitution: `chrome-extension://${id}/vendor/tikzjax/\\1`
        },
        condition: {
          // S3 버킷으로 나가는 모든 요청을 확장 리소스로 강제
          regexFilter: "^https://s3\\.us-east-2\\.amazonaws\\.com/tikzjax\\.com/(.*)$",
          resourceTypes: [
            "xmlhttprequest", "script", "other", "object", "media", "font", "image"
          ]
        }
      }]
    });
    console.log("[DNR] S3 → extension redirect rule installed");
  } catch (e) {
    console.warn("[DNR] Failed to install redirect rule", e);
  }
}

chrome.runtime.onInstalled.addListener(installRedirectRule);
chrome.runtime.onStartup.addListener(installRedirectRule);

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  const conf = {
    frameUrl: chrome.runtime.getURL("sandbox_frame.html"),
    fontCssUrl: chrome.runtime.getURL("vendor/tikzjax/font.css")
  };

  // MAIN 월드에 구성값 먼저 주입
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: "MAIN",
    func: (cfg) => { window.__CHATGPT_TIKZ_CONF__ = cfg; },
    args: [conf]
  });

  // MAIN 월드에 렌더러 실행
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: "MAIN",
    files: ["renderer.js"]
  });
});
