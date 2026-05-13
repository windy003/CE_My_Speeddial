const SPEED_DIAL_FOLDER_NAME = "Speed Dial";

// 按名称查找或自动创建 Speed Dial 文件夹
async function getSpeedDialFolderId() {
  const otherBookmarks = await chrome.bookmarks.getChildren("2");
  let folder = otherBookmarks.find(
    (b) => !b.url && b.title === SPEED_DIAL_FOLDER_NAME
  );
  if (!folder) {
    folder = await chrome.bookmarks.create({
      parentId: "2",
      title: SPEED_DIAL_FOLDER_NAME,
    });
  }
  return folder.id;
}

// 安装时创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "addToSpeedDial",
    title: "添加到 Speed Dial",
    contexts: ["page"],
  });
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "addToSpeedDial") return;

  const title = tab.title || "Untitled";
  const url = tab.url;

  if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return;

  const folderId = await getSpeedDialFolderId();
  await chrome.bookmarks.create({
    parentId: folderId,
    index: 0,
    title,
    url,
  });
});
