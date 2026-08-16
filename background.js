import {
    createFolder, saveSession, setActiveSession, getActiveSession, setActiveSessionWindowId, getActiveSessionWindowId, getAllFolders, saveFolders, deleteFolder,
    getSessionsInFolder, updateTabInActiveSession, removeTabFromActiveSession, renameSession, duplicateSession, deleteSession, getFolders
} from "./storage.js";

let isRestoring = false;     // Guards against autosave during session restore
let restoreHasRun = false;  // Ensures last session restore runs once per startup

const UI_PATH = "dist/index.html"; 
const UI_URL = chrome.runtime.getURL(UI_PATH);

function isValidURL(url) {
    if (!url || typeof url !== "string") return false;
    if (url === "chrome://newtab/") return false;
    if (url.startsWith("chrome://")) return false;
    if (url.startsWith("chrome-extension://")) return false;
    if (url === "about:blank") return false;
    if (url.trim() === "") return false;
    return true;
}

let reconcileDebounceTimer = null;
let reconcileGeneration = 0;

function scheduleReconcile(folderName, sessionName, windowId, delay = 300) {
    clearTimeout(reconcileDebounceTimer);
    const myGeneration = ++reconcileGeneration;

    reconcileDebounceTimer = setTimeout(async () => {
        // If a newer reconcile was scheduled after this one, skip — it'll run instead
        if (myGeneration !== reconcileGeneration) return;
        await syncSessionOrderFromWindow(folderName, sessionName, windowId);
    }, delay);
}

const FAVICON_CACHE_KEY = "faviconCache";
async function getCachedFavicon(url) {
    let domain;
    try { domain = new URL(url).origin; } catch { return ""; }

    const data = await chrome.storage.local.get([FAVICON_CACHE_KEY]);
    const cache = data[FAVICON_CACHE_KEY] || {};
    const entry = cache[domain];

    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (entry && (Date.now() - entry.cachedAt) < THIRTY_DAYS) {
        return entry.dataUrl;
    }

    try {
        const res = await fetch(`https://www.google.com/s2/favicons?sz=32&domain_url=${domain}`);
        const blob = await res.blob();
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        cache[domain] = { dataUrl, cachedAt: Date.now() };
        await chrome.storage.local.set({ [FAVICON_CACHE_KEY]: cache });
        return dataUrl;
    } catch {
        return "";
    }
}


const RECONCILE_ALARM_NAME = "periodic-session-reconcile";
const RECONCILE_INTERVAL_MINUTES = 5;

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(RECONCILE_ALARM_NAME, {
        periodInMinutes: RECONCILE_INTERVAL_MINUTES
    });
});

chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(RECONCILE_ALARM_NAME, {
        periodInMinutes: RECONCILE_INTERVAL_MINUTES
    });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== RECONCILE_ALARM_NAME) return;
    if (isRestoring) return;

    try {
        const active = await getActiveSession();
        if (!active) return;

        const activeWindowId = await getActiveSessionWindowId();
        if (activeWindowId == null) return;

        try {
            await chrome.windows.get(activeWindowId);
        } catch {
            return; // window was closed; nothing to reconcile
        }

        scheduleReconcile(active.folder, active.session, activeWindowId);
    } catch (e) {
        console.error("Periodic reconcile failed:", e);
    }
});

// Ensures the TabMax UI tab exists, pinned at index 0
async function ensureTabMaxInWindow(windowId) {
    const tabs = await chrome.tabs.query({ windowId });
    let tabMax = tabs.find(t => {
        try {
            return t.url === UI_URL;
        } catch {
            return false;
        }
    });
    
    // Reuse existing TabMax tab if present
    if (tabMax) {
        try {
            if (!tabMax.pinned) {
                await chrome.tabs.update(tabMax.id, { pinned: true });
            }
            await chrome.tabs.move(tabMax.id, { index: 0 });
        } catch (e) {
            console.warn("Failed to pin/move TabMax tab:", e);
        }
        return tabMax.id;
    }

    // Create and pin TabMax tab if missing
    const created = await chrome.tabs.create({ url: UI_URL, active: false, windowId });
    try {
        await chrome.tabs.update(created.id, { pinned: true });
        await chrome.tabs.move(created.id, { index: 0 });
    } catch (e) {
        console.warn("Failed to pin/move newly created TabMax tab:", e);
    }

    return created.id;
}

// Removes all tabs except the TabMax control tab
async function clearNonTabMaxTabs(windowId, exceptTabId) {
    const tabs = await chrome.tabs.query({ windowId });
    const toRemove = tabs.filter(t => t.id !== exceptTabId).map(t => t.id);
    if (toRemove.length > 0) {
        try {
            await chrome.tabs.remove(toRemove);
        } catch (e) {
            console.error("Failed to remove tabs:", e);
        }
    }
    return toRemove;
}

async function buildSessionSnapshot(windowId) {
    const tabs = await chrome.tabs.query({ windowId });

    const filteredTabs = tabs.filter(tab => {
        const url = tab.url || "";
        return (
            url.startsWith("http://") ||
            url.startsWith("https://") ||
            url.startsWith("file://") ||
            url.startsWith("data:")
        );
    });

    return filteredTabs.map(tab => ({
        id: tab.id,
        url: tab.url || "",
        title: tab.title || "",
        favicon: tab.favIconUrl || getCachedFavicon(tab.url),
        active: !!tab.active
    }));
}

async function saveCurrentSession(folderName, sessionName) {
    try {
        const win = await chrome.windows.getCurrent();
        const formatted = await buildSessionSnapshot(win.id);
        await saveSession(folderName, sessionName, formatted);
        return { success: true };
    } catch (e) {
        console.error("Error saving session:", e);
        return { success: false, error: e.message };
    }
}

async function syncSessionOrderFromWindow(folderName, sessionName, windowId) {
    try {
        const formatted = await buildSessionSnapshot(windowId);
        const sessions = await getSessionsInFolder(folderName);
        const current = sessions[sessionName] || [];

        const unchanged = JSON.stringify(current) === JSON.stringify(formatted);
        if (unchanged) return; 

        await saveSession(folderName, sessionName, formatted);
    } catch (e) {
        console.error("syncSessionOrderFromWindow failed:", e);
    }
}

// Restore a saved session into the current window
async function restoreSession(folderName, sessionName, { force = false } = {}) {
    // Prevent concurrent restore runs
    if (isRestoring) { return; }

    isRestoring = true;

    let cleaned = false;
    const finish = () => {
        if (!cleaned) {
            cleaned = true;
            isRestoring = false;
        }
    };

    try {
        // Skip restore if session is already active (unless forced)
        const active = await getActiveSession();
        if (
            !force &&
            active &&
            active.folder === folderName &&
            active.session === sessionName
        ) {
            finish();
            return;
        }

        const sessions = await getSessionsInFolder(folderName);
        const tabs = sessions[sessionName] || [];

        const win = await chrome.windows.getCurrent();

        // Ensure TabMax control tab exists and clear others
        const tabMaxId = await ensureTabMaxInWindow(win.id);
        await clearNonTabMaxTabs(win.id, tabMaxId);

        // Fallback when session is empty
        if (!tabs.length) {
            await chrome.tabs.create({
                url: "chrome://newtab",
                windowId: win.id,
                active: true,
                index: 1,
            });
            await setActiveSession(folderName, sessionName);
            await setActiveSessionWindowId(win.id);
            await saveCurrentSession(folderName, sessionName); // re-snapshot with real IDs
            finish();
            return;
        }

        // Recreate tabs in saved order
        const createdIds = [];
        for (let i = 0; i < tabs.length; i++) {
            const t = tabs[i];
            if (!t?.url) continue;

            try {
                const created = await chrome.tabs.create({
                    url: t.url,
                    windowId: win.id,
                    active: false,
                    index: i + 1,
                });
                createdIds.push(created.id);
            } catch (e) {
                // Ignore invalid or blocked URLs
            }
        }

        if (createdIds.length === 0) {
            await chrome.tabs.create({
                url: "chrome://newtab",
                windowId: win.id,
                active: true,
                index: 1,
            });
            await setActiveSession(folderName, sessionName);
            await setActiveSessionWindowId(win.id);
            await saveCurrentSession(folderName, sessionName); // re-snapshot with real IDs
            finish();
            return;
        }

        const { lastActiveTabIndex = 0 } =
            await chrome.storage.local.get("lastActiveTabIndex");

        const targetIndex = Math.min(
            Math.max(0, lastActiveTabIndex),
            createdIds.length - 1
        );

        await chrome.tabs.update(createdIds[targetIndex], { active: true });

        await setActiveSession(folderName, sessionName);
        await setActiveSessionWindowId(win.id);
        await saveCurrentSession(folderName, sessionName); // re-snapshot with real IDs

    } catch (err) {
        console.error("Restore failed:", err);
    } finally {
        finish();
    }
}

// Create an empty session and immediately switch to it
async function createAndSwitchToSession(folderName, sessionName) {
    // Temporarily suppress autosave during setup
    isRestoring = true;
    try {
        const existing = await getFolders();
        if (!existing[folderName]) {
            await createFolder(folderName);
        }

        const all = await chrome.storage.local.get(['folders']);
        const folders = all.folders || {};
        if (!folders[folderName]) folders[folderName] = { sessions: {} };
        folders[folderName].sessions[sessionName] = [];
        await chrome.storage.local.set({ folders: folders });

        const win = await chrome.windows.getCurrent();
        const tabMaxId = await ensureTabMaxInWindow(win.id);

        await clearNonTabMaxTabs(win.id, tabMaxId);

        const newTab = await chrome.tabs.create({ url: "chrome://newtab", windowId: win.id, active: true });

        await setActiveSession(folderName, sessionName);
        await setActiveSessionWindowId(win.id);

        return { success: true, tabId: newTab.id };
    } catch (err) {
        console.error("createAndSwitchToSession failed:", err);
        return { success: false, error: String(err) };
    } finally {
        // Await a brief delay so pending tab events fire while isRestoring is still true
        await new Promise(resolve => setTimeout(resolve, 400));
        isRestoring = false;
    }
}

async function tryRestoreLastSession() {
    if (restoreHasRun) return;
    restoreHasRun = true;

    const active = await getActiveSession();
    if (!active) return;

    console.log("Restoring last session:", active.folder, active.session);

    await restoreSession(active.folder, active.session, { force: true });
}

// Restore last active session on browser startup
chrome.runtime.onStartup.addListener(async () => {
    const windows = await chrome.windows.getAll();

    if (windows.length > 0) {
        tryRestoreLastSession();
        return;
    }

    chrome.windows.onCreated.addListener(function handle(win) {
        chrome.windows.onCreated.removeListener(handle);
        tryRestoreLastSession();
    });
});

// Handle messages from UI
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            if (msg.type === "CREATE_FOLDER" || msg.type === "SAVE_FOLDER") {
                await createFolder(msg.folderName);
                sendResponse({ success: true });

            } else if (msg.type === "SAVE_SESSION") {
                const existingFolders = await getFolders();
                if (!existingFolders[msg.folderName] && msg.folderName !== "") {
                    await createFolder(msg.folderName);
                }
                const res = await saveCurrentSession(msg.folderName, msg.sessionName);
                if (msg.setActive) await setActiveSession(msg.folderName, msg.sessionName);
                sendResponse(res);

            } else if (msg.type === "RESTORE_SESSION") {
                const { folderName, sessionName } = msg;
                await restoreSession(folderName, sessionName);
                sendResponse({ success: true });

            } else if (msg.type === "SET_ACTIVE_SESSION") {
                await setActiveSession(msg.folderName, msg.sessionName);
                sendResponse({ success: true });

            } else if (msg.type === "CREATE_AND_SWITCH_SESSION") {
                const folderName = msg.folderName || 'default';
                const sessionName = msg.sessionName;
                if (!sessionName) {
                    sendResponse({ success: false, error: "sessionName required" });
                } else {
                    const r = await createAndSwitchToSession(folderName, sessionName);
                    sendResponse(r);
                }

            } else if (msg.type === "DELETE_FOLDER") {
                const result = await deleteFolder(msg.folderName);
                sendResponse(result);

            } else if (msg.type === "DELETE_SESSION") {
                const result = await deleteSession(msg.folderName, msg.sessionName);
                sendResponse(result);
            } else if (msg.type === "RENAME_SESSION") {
                const result = await renameSession(msg.folderName, msg.oldSessionName, msg.newSessionName);
                sendResponse(result);
            } else if (msg.type === "DUPLICATE_SESSION") {
                const result = await duplicateSession(msg.folderName, msg.sessionName, msg.newSessionName);
                sendResponse(result);
            } else {
                sendResponse({ success: false, error: `Unknown message type: ${msg.type}` });
            }
        } catch (err) {
            console.error("Message handler error:", err);
            sendResponse({ success: false, error: String(err) });
        }
    })();

    return true;
});
 
// Update active tab state, skipping tabs still being created
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
        if (isRestoring) return;

        const tab = await chrome.tabs.get(tabId);
        if (!tab || !isValidURL(tab.url)) return;

        const win = await chrome.windows.getCurrent();
        if (tab.windowId !== win.id) return;

        await updateTabInActiveSession(tab, { source: "activated" });

        const activeSession = await getActiveSession();
        if (!activeSession) return;

        const sessions = await getSessionsInFolder(activeSession.folder);
        const sessionTabs = sessions[activeSession.session] || [];

        const idx = sessionTabs.findIndex(t => t.id === tabId);
        if (idx !== -1) {
            await chrome.storage.local.set({ lastActiveTabIndex: idx });
        }

    } catch (e) {
        console.error("onActivated failed:", e);
    }
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
    if (isRestoring) return;

    (async () => {
        const active = await getActiveSession();
        if (!active) return;

        const activeWindowId = await getActiveSessionWindowId();
        if (moveInfo.windowId !== activeWindowId) return;

        scheduleReconcile(active.folder, active.session, moveInfo.windowId);
    })();
});

// Autosave meaningful tab updates after creation settles
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    try {
        if (isRestoring) return;
        if (!isValidURL(tab.url)) return;

        const active = await getActiveSession();
        if (!active) return;

        const activeWindowId = await getActiveSessionWindowId();
        if (tab.windowId !== activeWindowId) return;

        if (changeInfo.status === "complete") {
            scheduleReconcile(active.folder, active.session, tab.windowId);
            return;
        }

        if (changeInfo.title || changeInfo.favIconUrl || changeInfo.url) {
            await updateTabInActiveSession(tab, { source: "updated", changeInfo });
        }
    } catch (e) {
        console.error("Autosave onUpdated failed:", e);
    }
});

// Remove tab from active session when closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
    if (isRestoring) return;
    try {
        await removeTabFromActiveSession(tabId);
    } catch (e) {
        console.error("Autosave onRemoved failed:", e);
    }
});

// Focus existing TabMax tab or create one if missing
chrome.action.onClicked.addListener(async () => {
    const url = UI_URL;

    const existing = await chrome.tabs.query({ url });

    if (existing.length > 0) {
        chrome.tabs.update(existing[0].id, { active: true });
        return;
    }

    const tab = await chrome.tabs.create({ url });

    chrome.tabs.update(tab.id, { pinned: true });

    chrome.tabs.move(tab.id, { index: 0 });
});

async function importFolders(importedData) {
    if (!importedData || typeof importedData !== 'object') {
        return { success: false, error: "INVALID_FORMAT" };
    }

    const folders = await getAllFolders();
    const importedFolderNames = [];

    for (const [folderName, folderData] of Object.entries(importedData)) {
        if (!folderData?.sessions || typeof folderData.sessions !== 'object') continue;

        let targetFolderName;

        if (folderName === 'default') {
            // Always merge into the existing default folder — never duplicate it
            targetFolderName = 'default';
            if (!folders[targetFolderName]) {
                folders[targetFolderName] = { sessions: {} };
            }
        } else {
            targetFolderName = folderName;
            let suffix = 1;
            while (folders[targetFolderName]) {
                targetFolderName = `${folderName} (imported${suffix > 1 ? ' ' + suffix : ''})`;
                suffix++;
            }
            folders[targetFolderName] = { sessions: {} };
        }

        for (const [sessionName, tabs] of Object.entries(folderData.sessions)) {
            if (!Array.isArray(tabs)) continue;

            // Auto-rename on session-name collision, in every folder including default
            let targetSessionName = sessionName;
            let sSuffix = 1;
            while (folders[targetFolderName].sessions[targetSessionName]) {
                targetSessionName = `${sessionName} (imported${sSuffix > 1 ? ' ' + sSuffix : ''})`;
                sSuffix++;
            }

            folders[targetFolderName].sessions[targetSessionName] = tabs.map(t => ({
                id: null,
                url: t.url || "",
                title: t.title || "",
                favicon: t.favicon || "",
                active: false
            }));
        }

        importedFolderNames.push(targetFolderName);
    }

    await saveFolders(folders);
    return { success: true, importedFolderNames };
}


const exportAll = async () => {
    const folders = await StorageClient.getAll(); // fresh read, not stale React state
    const json = JSON.stringify(folders, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `tabmax-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

// TODO:
// chrome.runtime.onInstalled.addListener(({reason}) => { 
//   if (reason === 'install') {
//     chrome.tabs.create({
//       url: "onboarding.html"
//     });
//   }
// });