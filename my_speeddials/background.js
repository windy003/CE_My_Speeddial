const SPEED_DIAL_ID = "8";

// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "addToSpeedDial",
    title: "添加到 Speed Dial",
    contexts: ["page"],
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "addToSpeedDial") return;

  const title = tab.title || "Untitled";
  const url = tab.url;

  if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return;

  await chrome.bookmarks.create({
    parentId: SPEED_DIAL_ID,
    title,
    url,
  });
});
