let speedDialId = null; // 快捷拨号根书签文件夹 ID
let currentFolderId = null; // 当前活动文件夹（null = 根目录）
let folders = []; // [{id, title}]
let dials = []; // [{id, title, url}]

// --- 根文件夹：书签 ID 8 ---
function getSpeedDialId() {
  speedDialId = "8";
}

// --- 从书签加载文件夹和快捷方式 ---
async function loadBookmarks() {
  const children = await chrome.bookmarks.getChildren(speedDialId);

  // 文件夹 = 快捷拨号根目录的子文件夹
  folders = children.filter((b) => !b.url).map((b) => ({ id: b.id, title: b.title }));

  // 确定要显示的文件夹
  const targetId = currentFolderId || speedDialId;

  // 从当前文件夹加载快捷方式
  const items = targetId === speedDialId
    ? children.filter((b) => b.url)
    : await chrome.bookmarks.getChildren(targetId);

  dials = (targetId === speedDialId ? items : items.filter((b) => b.url)).map((b) => ({
    id: b.id,
    title: b.title,
    url: b.url,
  }));
}

// --- 网站图标 ---
let faviconCache = {};

async function loadFaviconCache() {
  const result = await chrome.storage.local.get("faviconCache");
  faviconCache = result.faviconCache || {};
  console.log("Loaded favicon cache:", Object.keys(faviconCache).length, "entries");
}

function saveFaviconCache() {
  chrome.storage.local.set({ faviconCache }).catch((err) => {
    console.error("saveFaviconCache failed:", err);
  });
}

function getGoogleFavicon(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=128`;
  } catch {
    return null;
  }
}

// 将可能的相对 URL 解析为绝对 URL
function resolveUrl(href, base) {
  if (!href || href.includes("{{") || href.includes("{%")) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// 解析 sizes 属性（如 "192x192"）为数字
function parseIconSize(sizes) {
  if (!sizes) return 0;
  const match = sizes.match(/(\d+)x(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

// 测试图片 URL 是否可加载，返回其原始尺寸
function testImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ ok: true, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ ok: false, width: 0, height: 0 });
    img.src = src;
  });
}

// 通过 canvas 将图片 URL 转换为 data URL (base64)
function imageToDataUrl(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        resolve(canvas.toDataURL("image/webp", 0.9));
      } catch {
        resolve(src); // CORS 被阻止，回退到原始 URL
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// 从图片边缘提取背景颜色

// 从候选图片列表中选择最佳图片（最大的优先）
async function pickBest(candidates, minSize = 96) {
  let best = null;
  let bestSize = 0;
  for (const url of candidates) {
    if (!url) continue;
    const result = await testImage(url);
    if (result.ok && result.width > bestSize) {
      best = url;
      bestSize = result.width;
      if (bestSize >= 512) break; // 足够大了，停止
    }
  }
  if (!best || bestSize < minSize) return null;
  // 转换为 data URL 以便离线持久化
  const dataUrl = await imageToDataUrl(best);
  return dataUrl || best;
}

// 从页面获取所有候选图片
async function fetchImageCandidates(url) {
  const candidates = [];
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return candidates;
  }

  // 1. Brandfetch CDN（高质量品牌 logo，512x512）
  candidates.push(
    `https://cdn.brandfetch.io/domain/${hostname}/w/512/h/512/logo/fallback/404/?c=key`,
    `https://cdn.brandfetch.io/domain/${hostname}/w/512/h/512/icon/fallback/404/?c=key`
  );

  // 2. 获取页面 HTML 并提取图片
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const base = new URL(resp.url || url);

    // manifest.json 图标（按大小降序排列）
    const manifestLink = doc.querySelector('link[rel="manifest"]');
    if (manifestLink) {
      const mHref = resolveUrl(manifestLink.getAttribute("href"), base);
      if (mHref) {
        try {
          const mResp = await fetch(mHref, { signal: AbortSignal.timeout(3000) });
          const manifest = await mResp.json();
          if (manifest.icons && manifest.icons.length) {
            manifest.icons
              .filter((i) => i.src)
              .sort((a, b) => parseIconSize(b.sizes) - parseIconSize(a.sizes))
              .forEach((i) => {
                const src = resolveUrl(i.src, mHref);
                if (src) candidates.push(src);
              });
          }
        } catch {}
      }
    }

    // apple-touch-icon（按大小降序排列）
    const sizes = ["512x512", "256x256", "192x192", "180x180", "144x144", "96x96"];
    for (const sz of sizes) {
      const link = doc.querySelector(`link[rel="apple-touch-icon"][sizes="${sz}"]`);
      if (link) {
        const src = resolveUrl(link.getAttribute("href"), base);
        if (src) { candidates.push(src); break; }
      }
    }
    // 通用 apple-touch-icon
    const appleIcon = doc.querySelector('link[rel="apple-touch-icon"]');
    if (appleIcon) {
      const src = resolveUrl(appleIcon.getAttribute("href"), base);
      if (src) candidates.push(src);
    }

    // link[rel="icon"] 按大小排序
    for (const sz of sizes) {
      const link = doc.querySelector(`link[rel="icon"][sizes="${sz}"]`);
      if (link) {
        const src = resolveUrl(link.getAttribute("href"), base);
        if (src) { candidates.push(src); break; }
      }
    }
    // 通用图标链接
    const iconLinks = doc.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]');
    for (const link of iconLinks) {
      const src = resolveUrl(link.getAttribute("href"), base);
      if (src) candidates.push(src);
    }

  } catch {}

  // 3. 常见静态路径
  try {
    const base = new URL(url);
    candidates.push(
      `${base.origin}/apple-touch-icon.png`,
      `${base.origin}/favicon-192x192.png`,
      `${base.origin}/180x180.png`,
      `${base.origin}/favicon.png`,
      `${base.origin}/static/180x180.png`,
      `${base.origin}/favicon.ico`
    );
  } catch {}

  // 4. Google 图标服务
  candidates.push(getGoogleFavicon(url));

  // 去重
  return [...new Set(candidates.filter(Boolean))];
}

// 获取最佳图标：检查缓存或重新获取
// 返回 { icon, bgColor } 或 null
async function getFaviconUrl(url, skipCache) {
  if (!skipCache && faviconCache[url]) return faviconCache[url];

  const candidates = await fetchImageCandidates(url);
  const best = await pickBest(candidates, 32);

  if (best) {
    faviconCache[url] = { icon: best };
    saveFaviconCache();
    return faviconCache[url];
  }

  delete faviconCache[url];
  saveFaviconCache();
  return null;
}

function getInitial(name) {
  return name ? name.charAt(0).toUpperCase() : "?";
}

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 45%, 35%)`;
}

// --- 渲染文件夹标签 ---
function renderFolders() {
  const bar = document.getElementById("folderBar");
  bar.innerHTML = "";

  // 根目录的"首页"标签
  const homeTab = document.createElement("div");
  homeTab.className = "folder-tab" + (!currentFolderId ? " active" : "");
  homeTab.textContent = "Speed Dial";
  homeTab.dataset.folderId = speedDialId;
  homeTab.addEventListener("click", () => {
    currentFolderId = null;
    refresh();
  });
  bar.appendChild(homeTab);

  folders.forEach((folder, index) => {
    const tab = document.createElement("div");
    tab.className = "folder-tab" + (currentFolderId === folder.id ? " active" : "");
    tab.textContent = folder.title;
    tab.dataset.folderId = folder.id;
    tab.dataset.folderIndex = index;
    tab.addEventListener("click", () => {
      if (!folderDragMoved) {
        currentFolderId = folder.id;
        refresh();
      }
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openEditFolderModal(folder);
    });
    tab.addEventListener("mousedown", onFolderMouseDown);
    bar.appendChild(tab);
  });

  // 添加文件夹按钮
  const addTab = document.createElement("div");
  addTab.className = "folder-tab folder-add";
  addTab.textContent = "+";
  addTab.title = "新建文件夹";
  addTab.addEventListener("click", openAddFolderModal);
  bar.appendChild(addTab);
}

// --- 渲染快捷方式 ---
function renderDials() {
  const grid = document.getElementById("dialsGrid");
  grid.innerHTML = "";

  dials.forEach((dial, index) => {
    grid.appendChild(createDialElement(dial, index));
  });

}

// --- 文件夹标签拖拽排序 ---
let folderDragEl = null;
let folderDragClone = null;
let folderDragIndex = -1;
let folderDragStartX = 0;
let folderDragStartY = 0;
let folderIsDragging = false;
let folderDragMoved = false;
const FOLDER_DRAG_THRESHOLD = 8;

function onFolderMouseDown(e) {
  if (e.button !== 0) return;
  const el = e.currentTarget;
  folderDragEl = el;
  folderDragIndex = Number(el.dataset.folderIndex);
  folderDragStartX = e.clientX;
  folderDragStartY = e.clientY;
  folderIsDragging = false;
  folderDragMoved = false;

  document.addEventListener("mousemove", onFolderMouseMove);
  document.addEventListener("mouseup", onFolderMouseUp);
  e.preventDefault();
}

function onFolderMouseMove(e) {
  if (!folderDragEl) return;

  if (!folderIsDragging) {
    const dx = e.clientX - folderDragStartX;
    const dy = e.clientY - folderDragStartY;
    if (Math.sqrt(dx * dx + dy * dy) < FOLDER_DRAG_THRESHOLD) return;
    folderIsDragging = true;
    folderDragMoved = true;

    // 创建浮动克隆
    folderDragClone = folderDragEl.cloneNode(true);
    folderDragClone.className = "folder-tab folder-drag-clone";
    const rect = folderDragEl.getBoundingClientRect();
    folderDragClone.style.left = rect.left + "px";
    folderDragClone.style.top = rect.top + "px";
    document.body.appendChild(folderDragClone);

    folderDragEl.classList.add("folder-dragging");
  }

  // 移动克隆
  const rect = folderDragEl.getBoundingClientRect();
  folderDragClone.style.left = (e.clientX - (rect.width / 2)) + "px";
  folderDragClone.style.top = (e.clientY - (rect.height / 2)) + "px";

  // 检测悬停在哪个文件夹标签上，进行交换
  const bar = document.getElementById("folderBar");
  const tabs = [...bar.querySelectorAll(".folder-tab:not(.folder-add)")];
  // 排除首页标签（index 0），只对子文件夹排序
  const folderTabs = tabs.slice(1);

  for (const tab of folderTabs) {
    if (tab === folderDragEl) continue;
    const r = tab.getBoundingClientRect();
    if (e.clientX > r.left && e.clientX < r.right &&
        e.clientY > r.top && e.clientY < r.bottom) {
      const hoverIndex = Number(tab.dataset.folderIndex);
      if (hoverIndex !== folderDragIndex) {
        // 交换 folders 数组中的位置
        const [moved] = folders.splice(folderDragIndex, 1);
        folders.splice(hoverIndex, 0, moved);
        folderDragIndex = hoverIndex;
        rebuildFolderBar();
      }
      break;
    }
  }
}

async function onFolderMouseUp(e) {
  document.removeEventListener("mousemove", onFolderMouseMove);
  document.removeEventListener("mouseup", onFolderMouseUp);

  if (folderIsDragging && folderDragClone) {
    folderDragClone.remove();
    folderDragEl.classList.remove("folder-dragging");

    // 保存新的文件夹顺序到书签
    // 将文件夹按新顺序依次移动到前面的位置
    for (let i = 0; i < folders.length; i++) {
      await chrome.bookmarks.move(folders[i].id, { parentId: speedDialId, index: i });
    }
    await refresh();
  }

  // 延迟重置 folderDragMoved，防止 click 事件触发
  setTimeout(() => { folderDragMoved = false; }, 0);

  folderDragEl = null;
  folderDragClone = null;
  folderIsDragging = false;
  folderDragIndex = -1;
}

// 拖拽时轻量重建文件夹标签栏
function rebuildFolderBar() {
  const bar = document.getElementById("folderBar");
  // 保留首页标签和添加按钮
  const homeTab = bar.querySelector(".folder-tab:first-child");
  const addTab = bar.querySelector(".folder-add");

  // 移除所有子文件夹标签
  const oldTabs = [...bar.querySelectorAll(".folder-tab:not(.folder-add)")];
  oldTabs.slice(1).forEach(t => t.remove());

  // 按新顺序重建
  folders.forEach((folder, index) => {
    const tab = document.createElement("div");
    tab.className = "folder-tab" + (currentFolderId === folder.id ? " active" : "");
    if (index === folderDragIndex) tab.classList.add("folder-dragging");
    tab.textContent = folder.title;
    tab.dataset.folderId = folder.id;
    tab.dataset.folderIndex = index;
    tab.addEventListener("click", () => {
      if (!folderDragMoved) {
        currentFolderId = folder.id;
        refresh();
      }
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openEditFolderModal(folder);
    });
    tab.addEventListener("mousedown", onFolderMouseDown);
    bar.insertBefore(tab, addTab);
  });

  // 更新拖拽元素引用
  const newDragEl = bar.querySelector(`.folder-tab[data-folder-index="${folderDragIndex}"]`);
  if (newDragEl) {
    folderDragEl = newDragEl;
  }
}

// --- 拖拽排序（Android 风格）---
let dragEl = null;
let dragClone = null;
let dragIndex = -1;
let dragStartX = 0;
let dragStartY = 0;
let dragOffsetX = 0;
let dragOffsetY = 0;
let isDragging = false;
let dragDial = null; // 正在拖拽的快捷方式数据
let dragFolderTimer = null; // 悬停文件夹激活的计时器
const DRAG_THRESHOLD = 8;
const FOLDER_HOVER_DELAY = 500;

function onMouseDown(e) {
  // 仅响应鼠标左键，忽略编辑按钮点击
  if (e.button !== 0) return;

  const el = e.currentTarget;
  dragIndex = Number(el.dataset.index);
  dragDial = dials[dragIndex];
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragEl = el;
  isDragging = false;

  const rect = el.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  e.preventDefault();
}

function startDrag(e) {
  isDragging = true;

  // 创建浮动克隆元素
  dragClone = dragEl.cloneNode(true);
  dragClone.className = "dial drag-clone";
  const rect = dragEl.getBoundingClientRect();
  dragClone.style.width = rect.width + "px";
  dragClone.style.position = "fixed";
  dragClone.style.zIndex = "999";
  dragClone.style.pointerEvents = "none";
  dragClone.style.transform = "scale(1.08)";
  dragClone.style.opacity = "0.92";
  dragClone.style.transition = "transform 0.15s, opacity 0.15s";
  dragClone.style.left = (e.clientX - dragOffsetX) + "px";
  dragClone.style.top = (e.clientY - dragOffsetY) + "px";
  document.body.appendChild(dragClone);

  // 淡出原始元素
  dragEl.style.opacity = "0.2";
  dragEl.style.transition = "opacity 0.15s";
}

function onMouseMove(e) {
  if (!dragEl) return;

  if (!isDragging) {
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
    startDrag(e);
  }

  // 移动克隆元素
  dragClone.style.left = (e.clientX - dragOffsetX) + "px";
  dragClone.style.top = (e.clientY - dragOffsetY) + "px";

  // 检查是否悬停在文件夹标签上
  let overFolder = false;
  const folderTabs = document.querySelectorAll(".folder-tab:not(.folder-add)");
  folderTabs.forEach((tab) => {
    const rect = tab.getBoundingClientRect();
    if (e.clientX > rect.left && e.clientX < rect.right &&
        e.clientY > rect.top && e.clientY < rect.bottom) {
      tab.classList.add("drag-over");
      overFolder = true;
      const targetFolderId = tab.dataset.folderId;
      const currentId = currentFolderId || speedDialId;
      // 悬停在不同文件夹上，启动计时器
      if (targetFolderId !== currentId && !dragFolderTimer) {
        dragFolderTimer = setTimeout(async () => {
          // 切换到目标文件夹
          currentFolderId = targetFolderId === speedDialId ? null : targetFolderId;
          await loadBookmarks();
          renderFolders();
          renderDials();
          dragFolderTimer = null;
        }, FOLDER_HOVER_DELAY);
      }
    } else {
      tab.classList.remove("drag-over");
    }
  });

  // 离开文件夹标签区域，取消计时器
  if (!overFolder && dragFolderTimer) {
    clearTimeout(dragFolderTimer);
    dragFolderTimer = null;
  }

  // 不在文件夹标签上时，处理卡片排序 — 根据鼠标位置直接定位
  if (!overFolder) {
    const grid = document.getElementById("dialsGrid");
    const allDials = [...grid.querySelectorAll(".dial:not(.dial-add):not(.drag-clone)")];

    // 根据鼠标位置计算拖拽项应该插入的目标位置
    let newIndex = dials.length; // 默认放到末尾

    for (const el of allDials) {
      if (el === dragEl || !el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // 鼠标在该元素范围内 → 根据半区决定插入前面还是后面
      if (e.clientX >= rect.left && e.clientX < rect.right &&
          e.clientY >= rect.top && e.clientY < rect.bottom) {
        const idx = Number(el.dataset.index);
        newIndex = (e.clientX < centerX || e.clientY < centerY) ? idx : idx + 1;
        break;
      }

      // 鼠标在同一行的间隙中（该元素左边）
      if (e.clientY >= rect.top && e.clientY < rect.bottom &&
          e.clientX < rect.left) {
        newIndex = Number(el.dataset.index);
        break;
      }

      // 鼠标在该行末尾之后（换行前）
      if (e.clientY < rect.top) {
        newIndex = Number(el.dataset.index);
        break;
      }
    }

    // 修正索引：移除当前项后再计算目标位置
    if (newIndex > dragIndex) newIndex--;

    if (newIndex !== dragIndex) {
      const [moved] = dials.splice(dragIndex, 1);
      dials.splice(newIndex, 0, moved);
      dragIndex = newIndex;
      reorderGridElements();
    }
  }
}

// 拖拽时重排 DOM 元素（不重建，保留 dragEl 引用有效）
function reorderGridElements() {
  const grid = document.getElementById("dialsGrid");
  const addBtn = grid.querySelector(".dial-add");

  // 按 dials 数组顺序重新排列 DOM 元素
  dials.forEach((dial) => {
    const el = grid.querySelector(`.dial[data-id="${dial.id}"]`);
    if (el) {
      grid.insertBefore(el, addBtn);
    }
  });

  // 更新所有元素的 dataset.index
  const allDials = grid.querySelectorAll(".dial:not(.dial-add)");
  allDials.forEach((el, i) => {
    el.dataset.index = i;
  });
}

async function onMouseUp(e) {
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);

  // 清除文件夹高亮和计时器
  document.querySelectorAll(".folder-tab.drag-over").forEach((tab) => {
    tab.classList.remove("drag-over");
  });
  if (dragFolderTimer) {
    clearTimeout(dragFolderTimer);
    dragFolderTimer = null;
  }

  if (isDragging && dragClone) {
    const targetParentId = currentFolderId || speedDialId;

    // 动画回到目标位置
    const finalEl = document.querySelector(`.dial[data-index="${dragIndex}"]`);
    if (finalEl) {
      const rect = finalEl.getBoundingClientRect();
      dragClone.style.transition = "left 0.2s ease, top 0.2s ease, transform 0.2s ease, opacity 0.2s ease";
      dragClone.style.left = rect.left + "px";
      dragClone.style.top = rect.top + "px";
      dragClone.style.transform = "scale(1)";
      dragClone.style.opacity = "1";
      await new Promise((r) => setTimeout(r, 200));
    }
    dragClone.remove();

    // 保存所有书签的新顺序
    // 根目录下有文件夹排在前面，需要加上文件夹数量的偏移
    const folderOffset = (targetParentId === speedDialId) ? folders.length : 0;
    try {
      for (let i = 0; i < dials.length; i++) {
        await chrome.bookmarks.move(dials[i].id, { parentId: targetParentId, index: folderOffset + i });
      }
    } catch (err) {
      console.error("保存排序失败:", err);
    }
    await refresh();
  } else if (dragEl && !isDragging) {
    // 是点击而非拖拽 — 导航到链接
    window.location.href = dragEl.href;
  }

  if (dragEl) {
    dragEl.style.opacity = "1";
    dragEl.style.transition = "";
  }
  dragEl = null;
  dragClone = null;
  dragDial = null;
  isDragging = false;
  dragIndex = -1;
}

// 创建单个快捷方式元素（renderDials 和 reorderGridElements 共用）
function createDialElement(dial, index) {
  const el = document.createElement("a");
  el.className = "dial";
  el.href = dial.url;
  el.dataset.index = index;
  el.dataset.id = dial.id;

  const thumb = document.createElement("div");
  thumb.className = "dial-thumb";

  const cached = faviconCache[dial.url];
  // 兼容旧缓存格式（纯字符串）和新格式（{icon}）
  const cachedIcon = cached ? (cached.icon || cached) : null;
  thumb.style.backgroundColor = stringToColor(dial.url);

  const letter = document.createElement("span");
  letter.className = "dial-initial";
  letter.textContent = getInitial(dial.title);
  thumb.appendChild(letter);

  if (cachedIcon) {
    const img = document.createElement("img");
    img.src = typeof cachedIcon === "string" ? cachedIcon : "";
    img.className = "dial-favicon";
    img.onload = () => letter.remove();
    img.onerror = () => img.remove();
    thumb.prepend(img);
  }

  const label = document.createElement("span");
  label.className = "dial-label";
  label.textContent = dial.title;

  el.appendChild(thumb);
  el.appendChild(label);
  el.addEventListener("mousedown", onMouseDown);

  return el;
}

// --- 快捷方式弹窗 ---
const dialModal = document.getElementById("dialModal");
const dialNameInput = document.getElementById("dialName");
const dialUrlInput = document.getElementById("dialUrl");
let editingDial = null;

function openEditDialModal(dial) {
  editingDial = dial;
  document.getElementById("dialModalTitle").textContent = "编辑快捷方式";
  dialNameInput.value = dial.title;
  dialUrlInput.value = dial.url;
  document.getElementById("btnDialDelete").style.display = "inline-block";
  dialModal.classList.add("active");
  dialNameInput.focus();
}

function closeDialModal() {
  dialModal.classList.remove("active");
}

document.getElementById("btnDialCancel").addEventListener("click", closeDialModal);
dialModal.addEventListener("click", (e) => {
  if (e.target === dialModal) closeDialModal();
});

document.getElementById("btnDialSave").addEventListener("click", async () => {
  const title = dialNameInput.value.trim();
  let url = dialUrlInput.value.trim();
  if (!title || !url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  if (!editingDial) {
    await chrome.bookmarks.create({
      parentId: currentFolderId || speedDialId,
      title,
      url,
    });
  } else {
    await chrome.bookmarks.update(editingDial.id, { title, url });
  }
  closeDialModal();
  await refresh();
});

document.getElementById("btnDialDelete").addEventListener("click", async () => {
  if (editingDial) {
    await chrome.bookmarks.remove(editingDial.id);
    closeDialModal();
    await refresh();
  }
});

// --- 文件夹弹窗 ---
const folderModal = document.getElementById("folderModal");
const folderNameInput = document.getElementById("folderName");
let editingFolder = null;

function openAddFolderModal() {
  editingFolder = null;
  document.getElementById("folderModalTitle").textContent = "新建文件夹";
  folderNameInput.value = "";
  document.getElementById("btnFolderDelete").style.display = "none";
  folderModal.classList.add("active");
  folderNameInput.focus();
}

function openEditFolderModal(folder) {
  editingFolder = folder;
  document.getElementById("folderModalTitle").textContent = "编辑文件夹";
  folderNameInput.value = folder.title;
  document.getElementById("btnFolderDelete").style.display = "inline-block";
  folderModal.classList.add("active");
  folderNameInput.focus();
}

function closeFolderModal() {
  folderModal.classList.remove("active");
}

document.getElementById("btnFolderCancel").addEventListener("click", closeFolderModal);
folderModal.addEventListener("click", (e) => {
  if (e.target === folderModal) closeFolderModal();
});

document.getElementById("btnFolderSave").addEventListener("click", async () => {
  const title = folderNameInput.value.trim();
  if (!title) return;

  if (!editingFolder) {
    const created = await chrome.bookmarks.create({
      parentId: speedDialId,
      title,
    });
    currentFolderId = created.id;
  } else {
    await chrome.bookmarks.update(editingFolder.id, { title });
  }
  closeFolderModal();
  await refresh();
});

document.getElementById("btnFolderDelete").addEventListener("click", async () => {
  if (editingFolder) {
    await chrome.bookmarks.removeTree(editingFolder.id);
    if (currentFolderId === editingFolder.id) currentFolderId = null;
    closeFolderModal();
    await refresh();
  }
});

// --- 右键菜单 ---
const dialMenu = document.getElementById("dialMenu");
const globalMenu = document.getElementById("globalMenu");
let ctxDial = null;
let ctxThumb = null;

function showMenu(el, x, y) {
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.classList.add("active");
  // 保持在视口内
  const rect = el.getBoundingClientRect();
  if (rect.right > window.innerWidth) el.style.left = (window.innerWidth - rect.width - 8) + "px";
  if (rect.bottom > window.innerHeight) el.style.top = (window.innerHeight - rect.height - 8) + "px";
}

function hideAllMenus() {
  dialMenu.classList.remove("active");
  globalMenu.classList.remove("active");
  ctxDial = null;
  ctxThumb = null;
}

// 全局右键菜单处理
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  hideAllMenus();

  const dialEl = e.target.closest(".dial:not(.dial-add)");
  if (dialEl) {
    // 查找对应的快捷方式数据
    const idx = Number(dialEl.dataset.index);
    ctxDial = dials[idx];
    ctxThumb = dialEl.querySelector(".dial-thumb");
    showMenu(dialMenu, e.pageX, e.pageY);
  } else {
    showMenu(globalMenu, e.pageX, e.pageY);
  }
});

// 点击任意位置关闭菜单
window.addEventListener("click", (e) => {
  if (!e.target.closest(".context-menu")) {
    hideAllMenus();
  }
});

// 快捷方式菜单操作
dialMenu.addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (!action || !ctxDial) return;
  const dial = ctxDial;
  const thumb = ctxThumb;
  hideAllMenus();

  if (action === "refreshIcon") {
    delete faviconCache[dial.url];
    saveFaviconCache();
    getFaviconUrl(dial.url, true).then((result) => {
      const oldImg = thumb.querySelector(".dial-favicon");
      const oldLetter = thumb.querySelector(".dial-initial");
      if (result) {
        const img = document.createElement("img");
        img.src = result.icon;
        img.className = "dial-favicon";
        img.onload = () => { if (oldLetter) oldLetter.remove(); };
        img.onerror = () => img.remove();
        if (oldImg) oldImg.replaceWith(img); else thumb.prepend(img);
      }
    });
  } else if (action === "edit") {
    openEditDialModal(dial);
  } else if (action === "delete") {
    await chrome.bookmarks.remove(dial.id);
    await refresh();
  }
});

// 全局菜单操作
globalMenu.addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  hideAllMenus();

  if (action === "refreshAll") {
    // 仅清除当前文件夹快捷方式的缓存
    for (const dial of dials) {
      delete faviconCache[dial.url];
    }
    saveFaviconCache();
    const thumbEls = document.querySelectorAll(".dial:not(.dial-add)");
    for (const el of thumbEls) {
      const idx = Number(el.dataset.index);
      const dial = dials[idx];
      if (!dial) continue;
      const thumb = el.querySelector(".dial-thumb");
      getFaviconUrl(dial.url, true).then((result) => {
        const oldImg = thumb.querySelector(".dial-favicon");
        const oldLetter = thumb.querySelector(".dial-initial");
        if (result) {
          const img = document.createElement("img");
          img.src = result.icon;
          img.className = "dial-favicon";
          img.onload = () => { if (oldLetter) oldLetter.remove(); };
          img.onerror = () => img.remove();
          if (oldImg) oldImg.replaceWith(img); else thumb.prepend(img);
        }
      });
    }
  }
});

// --- 键盘事件 ---
document.addEventListener("keydown", (e) => {
  if (dialModal.classList.contains("active")) {
    if (e.key === "Enter") document.getElementById("btnDialSave").click();
    if (e.key === "Escape") closeDialModal();
  } else if (folderModal.classList.contains("active")) {
    if (e.key === "Enter") document.getElementById("btnFolderSave").click();
    if (e.key === "Escape") closeFolderModal();
  }
});

// --- 刷新 ---
async function refresh() {
  await loadBookmarks();
  renderFolders();
  renderDials();
}

// --- 初始化 ---
async function init() {
  await loadFaviconCache();
  getSpeedDialId();
  await refresh();
}

init();
