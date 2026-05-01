let speedDialId = null; // Root "Speed Dial" bookmark folder ID
let currentFolderId = null; // Currently active folder (null = root)
let folders = []; // [{id, title}]
let dials = []; // [{id, title, url}]

// --- Root folder: bookmark ID 8 ---
function getSpeedDialId() {
  speedDialId = "8";
}

// --- Load folders and dials from bookmarks ---
async function loadBookmarks() {
  const children = await chrome.bookmarks.getChildren(speedDialId);

  // Folders = subfolders of Speed Dial root
  folders = children.filter((b) => !b.url).map((b) => ({ id: b.id, title: b.title }));

  // Determine which folder to show
  const targetId = currentFolderId || speedDialId;

  // Load dials from current folder
  const items = targetId === speedDialId
    ? children.filter((b) => b.url)
    : await chrome.bookmarks.getChildren(targetId);

  dials = (targetId === speedDialId ? items : items.filter((b) => b.url)).map((b) => ({
    id: b.id,
    title: b.title,
    url: b.url,
  }));
}

// --- Favicon ---
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

// Resolve a potentially relative URL against a base
function resolveUrl(href, base) {
  if (!href || href.includes("{{") || href.includes("{%")) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// Parse sizes attribute like "192x192" to number
function parseIconSize(sizes) {
  if (!sizes) return 0;
  const match = sizes.match(/(\d+)x(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

// Test if an image URL loads, return its natural size
function testImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ ok: true, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ ok: false, width: 0, height: 0 });
    img.src = src;
  });
}

// Convert image URL to data URL (base64) via canvas
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
        resolve(src); // CORS blocked, fall back to URL
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Extract background color from image edges (like reference project)
function extractBgColor(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        let totalPixels = 0;
        const avg = [0, 0, 0, 0];
        const colorCounts = [];

        function colorsAreSimilar(c1, c2) {
          return Math.abs(c1[0] - c2[0]) <= 2 &&
                 Math.abs(c1[1] - c2[1]) <= 2 &&
                 Math.abs(c1[2] - c2[2]) <= 2;
        }

        function sample(px) {
          avg[0] += px[0]; avg[1] += px[1]; avg[2] += px[2]; avg[3] += px[3];
          totalPixels++;
          let found = false;
          for (const cc of colorCounts) {
            if (colorsAreSimilar(cc.color, px)) { cc.count++; found = true; break; }
          }
          if (!found) colorCounts.push({ color: [...px], count: 1 });
        }

        // Sample top/bottom edges
        for (let x = 0; x < w; x += 2) {
          for (let y = 0; y < 2; y++) {
            sample(ctx.getImageData(x, y, 1, 1).data);
            if (h > 2) sample(ctx.getImageData(x, h - 1 - y, 1, 1).data);
          }
        }
        // Sample left/right edges
        for (let y = 2; y < h - 2; y += 2) {
          for (let x = 0; x < 2; x++) {
            sample(ctx.getImageData(x, y, 1, 1).data);
            if (w > 2) sample(ctx.getImageData(w - 1 - x, y, 1, 1).data);
          }
        }

        // Find most common color
        let best = null, maxCount = 0;
        for (const cc of colorCounts) {
          if (cc.count > maxCount) { maxCount = cc.count; best = cc.color; }
        }

        if (maxCount > totalPixels / 2 && best) {
          resolve(`rgb(${best[0]},${best[1]},${best[2]})`);
        } else {
          const r = Math.round(avg[0] / totalPixels);
          const g = Math.round(avg[1] / totalPixels);
          const b = Math.round(avg[2] / totalPixels);
          resolve(`rgb(${r},${g},${b})`);
        }
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Pick the best image from a list of candidates (largest wins)
async function pickBest(candidates, minSize = 96) {
  let best = null;
  let bestSize = 0;
  for (const url of candidates) {
    if (!url) continue;
    const result = await testImage(url);
    if (result.ok && result.width > bestSize) {
      best = url;
      bestSize = result.width;
      if (bestSize >= 256) break; // good enough, stop
    }
  }
  if (!best || bestSize < minSize) return null;
  // Convert to data URL so it persists offline
  const dataUrl = await imageToDataUrl(best);
  return dataUrl || best;
}

// Fetch all candidate images from a page
async function fetchImageCandidates(url) {
  const candidates = [];
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return candidates;
  }

  // 1. Brandfetch CDN (high quality brand logos, 256x256)
  candidates.push(
    `https://cdn.brandfetch.io/domain/${hostname}/w/256/h/256/logo/fallback/404/?c=key`,
    `https://cdn.brandfetch.io/domain/${hostname}/w/256/h/256/icon/fallback/404/?c=key`
  );

  // 2. Fetch the page HTML and extract images
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const base = new URL(resp.url || url);

    // manifest.json icons (sorted largest first)
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

    // apple-touch-icon (sorted by size, largest first)
    const sizes = ["512x512", "256x256", "192x192", "180x180", "144x144", "96x96"];
    for (const sz of sizes) {
      const link = doc.querySelector(`link[rel="apple-touch-icon"][sizes="${sz}"]`);
      if (link) {
        const src = resolveUrl(link.getAttribute("href"), base);
        if (src) { candidates.push(src); break; }
      }
    }
    // Generic apple-touch-icon
    const appleIcon = doc.querySelector('link[rel="apple-touch-icon"]');
    if (appleIcon) {
      const src = resolveUrl(appleIcon.getAttribute("href"), base);
      if (src) candidates.push(src);
    }

    // link[rel="icon"] sorted by size
    for (const sz of sizes) {
      const link = doc.querySelector(`link[rel="icon"][sizes="${sz}"]`);
      if (link) {
        const src = resolveUrl(link.getAttribute("href"), base);
        if (src) { candidates.push(src); break; }
      }
    }
    // Generic icon link
    const iconLinks = doc.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]');
    for (const link of iconLinks) {
      const src = resolveUrl(link.getAttribute("href"), base);
      if (src) candidates.push(src);
    }

  } catch {}

  // 3. Common static paths
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

  // 4. Google favicon service
  candidates.push(getGoogleFavicon(url));

  // Deduplicate
  return [...new Set(candidates.filter(Boolean))];
}

// Get best favicon: check cache or fetch fresh
// Returns { icon, bgColor } or null
async function getFaviconUrl(url, skipCache) {
  if (!skipCache && faviconCache[url]) return faviconCache[url];

  const candidates = await fetchImageCandidates(url);
  const best = await pickBest(candidates, 32);

  if (best) {
    const bgColor = await extractBgColor(best) || "#222";
    faviconCache[url] = { icon: best, bgColor };
    saveFaviconCache();
    return faviconCache[url];
  }

  delete faviconCache[url];
  saveFaviconCache();
  return null;
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
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

// --- Render Folder Tabs ---
function renderFolders() {
  const bar = document.getElementById("folderBar");
  bar.innerHTML = "";

  // "Home" tab for root
  const homeTab = document.createElement("div");
  homeTab.className = "folder-tab" + (!currentFolderId ? " active" : "");
  homeTab.textContent = "Speed Dial";
  homeTab.dataset.folderId = speedDialId;
  homeTab.addEventListener("click", () => {
    currentFolderId = null;
    refresh();
  });
  bar.appendChild(homeTab);

  folders.forEach((folder) => {
    const tab = document.createElement("div");
    tab.className = "folder-tab" + (currentFolderId === folder.id ? " active" : "");
    tab.textContent = folder.title;
    tab.dataset.folderId = folder.id;
    tab.addEventListener("click", () => {
      currentFolderId = folder.id;
      refresh();
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openEditFolderModal(folder);
    });
    bar.appendChild(tab);
  });

  // Add folder button
  const addTab = document.createElement("div");
  addTab.className = "folder-tab folder-add";
  addTab.textContent = "+";
  addTab.title = "新建文件夹";
  addTab.addEventListener("click", openAddFolderModal);
  bar.appendChild(addTab);
}

// --- Render Dials ---
function renderDials() {
  const grid = document.getElementById("dialsGrid");
  grid.innerHTML = "";

  dials.forEach((dial, index) => {
    grid.appendChild(createDialElement(dial, index));
  });

}

// --- Drag & Drop (Android-style) ---
let dragEl = null;
let dragClone = null;
let dragIndex = -1;
let dragStartX = 0;
let dragStartY = 0;
let dragOffsetX = 0;
let dragOffsetY = 0;
let isDragging = false;
let dragDial = null; // The actual dial data being dragged
let dragFolderTimer = null; // Timer for folder activation on hover
const DRAG_THRESHOLD = 8;
const FOLDER_HOVER_DELAY = 500;

function onMouseDown(e) {
  // Only left mouse button, ignore edit button clicks
  if (e.button !== 0 || e.target.closest(".edit-btn")) return;

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

  // Create floating clone
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

  // Fade out original
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

  // Move clone
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

  // 不在文件夹标签上时，处理卡片排序
  if (!overFolder) {
    const grid = document.getElementById("dialsGrid");
    const dialEls = [...grid.querySelectorAll(".dial:not(.dial-add):not(.drag-clone)")];
    for (const el of dialEls) {
      const rect = el.getBoundingClientRect();
      if (e.clientX > rect.left && e.clientX < rect.right &&
          e.clientY > rect.top && e.clientY < rect.bottom) {
        const hoverIndex = Number(el.dataset.index);
        if (hoverIndex !== dragIndex) {
          const [moved] = dials.splice(dragIndex, 1);
          dials.splice(hoverIndex, 0, moved);
          dragIndex = hoverIndex;
          rebuildGrid();
        }
        break;
      }
    }
  }
}

// Rebuild grid DOM without re-fetching (lightweight re-render for drag)
function rebuildGrid() {
  const grid = document.getElementById("dialsGrid");
  const dialEls = [...grid.querySelectorAll(".dial:not(.dial-add)")];
  const addBtn = grid.querySelector(".dial-add");

  // Remove old dials
  dialEls.forEach((el) => el.remove());

  // Re-insert dials in new order
  dials.forEach((dial, index) => {
    const el = createDialElement(dial, index);
    grid.insertBefore(el, addBtn);
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

    // 移动书签到当前文件夹的当前位置
    await chrome.bookmarks.move(dragDial.id, { parentId: targetParentId, index: dragIndex });
    await refresh();
  } else if (dragEl && !isDragging) {
    // It was a click, not a drag — navigate
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

// Create a single dial element (used by both renderDials and rebuildGrid)
function createDialElement(dial, index) {
  const el = document.createElement("a");
  el.className = "dial";
  el.href = dial.url;
  el.dataset.index = index;
  el.dataset.id = dial.id;

  const thumb = document.createElement("div");
  thumb.className = "dial-thumb";

  const cached = faviconCache[dial.url];
  // 兼容旧缓存格式（纯字符串）和新格式（{icon, bgColor}）
  const cachedIcon = cached ? (cached.icon || cached) : null;
  const cachedBg = cached && cached.bgColor ? cached.bgColor : stringToColor(dial.url);
  thumb.style.backgroundColor = cachedBg;

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

  const editBtn = document.createElement("button");
  editBtn.className = "edit-btn";
  editBtn.innerHTML = "&#9998;";
  editBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openEditDialModal(dial);
  });
  thumb.appendChild(editBtn);

  const label = document.createElement("span");
  label.className = "dial-label";
  label.textContent = dial.title;

  el.appendChild(thumb);
  el.appendChild(label);
  el.addEventListener("mousedown", onMouseDown);

  return el;
}

// --- Dial Modal ---
const dialModal = document.getElementById("dialModal");
const dialNameInput = document.getElementById("dialName");
const dialUrlInput = document.getElementById("dialUrl");
let editingDial = null;

function openAddDialModal() {
  editingDial = null;
  document.getElementById("dialModalTitle").textContent = "添加快捷方式";
  dialNameInput.value = "";
  dialUrlInput.value = "";
  document.getElementById("btnDialDelete").style.display = "none";
  dialModal.classList.add("active");
  dialNameInput.focus();
}

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

// --- Folder Modal ---
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

// --- Context Menu ---
const dialMenu = document.getElementById("dialMenu");
const globalMenu = document.getElementById("globalMenu");
let ctxDial = null;
let ctxThumb = null;

function showMenu(el, x, y) {
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.classList.add("active");
  // Keep in viewport
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

// Single global contextmenu handler (like reference project)
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  hideAllMenus();

  const dialEl = e.target.closest(".dial:not(.dial-add)");
  if (dialEl) {
    // Find corresponding dial data
    const idx = Number(dialEl.dataset.index);
    ctxDial = dials[idx];
    ctxThumb = dialEl.querySelector(".dial-thumb");
    showMenu(dialMenu, e.pageX, e.pageY);
  } else {
    showMenu(globalMenu, e.pageX, e.pageY);
  }
});

// Click anywhere closes menus
window.addEventListener("click", (e) => {
  if (!e.target.closest(".context-menu")) {
    hideAllMenus();
  }
});

// Dial menu actions
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
        thumb.style.backgroundColor = result.bgColor;
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

// Global menu actions
globalMenu.addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  hideAllMenus();

  if (action === "refreshAll") {
    // Only clear cache for current folder's dials
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
          thumb.style.backgroundColor = result.bgColor;
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

// --- Keyboard ---
document.addEventListener("keydown", (e) => {
  if (dialModal.classList.contains("active")) {
    if (e.key === "Enter") document.getElementById("btnDialSave").click();
    if (e.key === "Escape") closeDialModal();
  } else if (folderModal.classList.contains("active")) {
    if (e.key === "Enter") document.getElementById("btnFolderSave").click();
    if (e.key === "Escape") closeFolderModal();
  }
});

// --- Refresh ---
async function refresh() {
  await loadBookmarks();
  renderFolders();
  renderDials();
}

// --- Init ---
async function init() {
  await loadFaviconCache();
  getSpeedDialId();
  await refresh();
}

init();
