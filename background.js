import {
    createFolder, saveSession, setActiveSession, getActiveSession,
    getSessionsInFolder, updateTabInActiveSession, removeTabFromActiveSession,
    deleteFolder, deleteSession, getFolders, createNewTabInActiveSession
} from "./storage.js";

let isRestoring = false;     // Guards against autosave during session restore
let restoreHasRun = false;  // Ensures last session restore runs once per startup

const UI_PATH = "dist/index.html"; 
const UI_URL = chrome.runtime.getURL(UI_PATH);

function getFavicon(url) {
    try {
        const domain = new URL(url).origin;
        return `https://www.google.com/s2/favicons?sz=32&domain_url=${domain}`;
    } catch {
        return "";
    }
}

function isValidURL(url) {
    if (!url || typeof url !== "string") return false;
    if (url === "chrome://newtab/") return false;
    if (url.startsWith("chrome://")) return false;
    if (url.startsWith("chrome-extension://")) return false;
    if (url === "about:blank") return false;
    if (url.trim() === "") return false;
    return true;
}

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

// Persist current window tabs as a session snapshot
async function saveCurrentSession(folderName, sessionName) {
    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });

        // Filter to persistable URLs only
        const filteredTabs = tabs.filter(tab => {
            const url = tab.url || "";
            return (
                url.startsWith("http://") ||
                url.startsWith("https://") ||
                url.startsWith("file://") ||   
                url.startsWith("data:")     
            );
        });

        const formatted = filteredTabs.map(tab => ({
            id: tab.id,
            url: tab.url || "",
            title: tab.title || "",
            favicon: tab.favIconUrl || getFavicon(tab.url),
            active: !!tab.active
        }));

        await saveSession(folderName, sessionName, formatted);
        return { success: true };

    } catch (e) {
        console.error("Error saving session:", e);
        return { success: false, error: e.message };
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

// Persist newly created tabs (including duplicates)
chrome.tabs.onCreated.addListener(async (tab) => {
    try {
        if (isRestoring) return;

        if (!tab || !isValidURL(tab.pendingUrl || tab.url)) return;
        
        const win = await chrome.windows.getCurrent();
        if (tab.windowId !== win.id) return;

        await createNewTabInActiveSession(tab);
    } catch (e) {
        console.error("Autosave onCreated failed:", e);
    } 
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

// Autosave meaningful tab updates after creation settles
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    try {
        if (isRestoring) return;

        if (!changeInfo.status &&
            !changeInfo.title &&
            !changeInfo.favIconUrl &&
            !changeInfo.url) {
            return;
        }

        if (!isValidURL(tab.url)) return;

        const active = await getActiveSession();
        if (!active) return;

        const win = await chrome.windows.getCurrent();
        if (tab.windowId !== win.id) return;

        await updateTabInActiveSession(tab, { source: "updated", changeInfo });

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

// TODO:
// chrome.runtime.onInstalled.addListener(({reason}) => { 
//   if (reason === 'install') {
//     chrome.tabs.create({
//       url: "onboarding.html"
//     });
//   }
// });