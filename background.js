import {
    createFolder, saveSession, setActiveSession, getActiveSession,
    getSessionsInFolder, updateTabInActiveSession, removeTabFromActiveSession,
    deleteFolder, deleteSession, getFolders
} from "./storage.js";

let isRestoring = false;
let restoreHasRun = false;

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

async function ensureTabMaxInWindow(windowId) {
    const tabs = await chrome.tabs.query({ windowId });
    let tabMax = tabs.find(t => {
        try {
            return t.url === UI_URL;
        } catch {
            return false;
        }
    });

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

    const created = await chrome.tabs.create({ url: UI_URL, active: false });
    try {
        await chrome.tabs.update(created.id, { pinned: true });
        await chrome.tabs.move(created.id, { index: 0 });
    } catch (e) {
        console.warn("Failed to pin/move newly created TabMax tab:", e);
    }

    return created.id;
}

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

async function saveCurrentSession(folderName, sessionName) {
    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });

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

async function restoreSession(folderName, sessionName, { force = false } = {}) {
    isRestoring = true;

    try {
        const active = await getActiveSession();
        if (
            !force &&
            active &&
            active.folder === folderName &&
            active.session === sessionName
        ) {
            console.log("Already active — skipping restore.");
            return; 
        }
        
        const sessions = await getSessionsInFolder(folderName);
        const tabs = sessions[sessionName] || [];

        const win = await chrome.windows.getCurrent();
        const tabMaxId = await ensureTabMaxInWindow(win.id);

        await clearNonTabMaxTabs(win.id, tabMaxId);

        if (!tabs.length) {
            await chrome.tabs.create({ url: "chrome://newtab", windowId: win.id, active: true });
            await setActiveSession(folderName, sessionName);
            return;
        }

        for (let i = 0; i < tabs.length; i++) {
            const t = tabs[i];
            if (!t?.url) continue;
            const url = t.url;
            if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
                continue;
            }
            await chrome.tabs.create({ url, windowId: win.id, active: false });
        }

        const data = await chrome.storage.local.get("lastActiveTabIndex");
        const lastActiveTabIndex = data.lastActiveTabIndex ?? 0;

        const newList = await chrome.tabs.query({ windowId: win.id });
        const indexToActivate = Math.min(Math.max(0, lastActiveTabIndex + 1), newList.length - 1); // +1 because tabMax at 0
        if (newList[indexToActivate]) {
            await chrome.tabs.update(newList[indexToActivate].id, { active: true });
        }

        await setActiveSession(folderName, sessionName);

    } catch (err) {
        console.error("Restore failed:", err);
    } finally {
        setTimeout(() => { isRestoring = false; }, 500);
    }
}

async function createAndSwitchToSession(folderName, sessionName) {
    isRestoring = true;
    try {
        const existing = await getFolders();
        if (!existing[folderName]) {
            await createFolder(folderName);
        }

        const all = await chrome.storage.local.get(['folders']);
        const f = all.folders || {};
        if (!f[folderName]) f[folderName] = { sessions: {} };
        f[folderName].sessions[sessionName] = [];
        await chrome.storage.local.set({ folders: f });

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
        setTimeout(() => { isRestoring = false; }, 400);
    }
}

async function tryRestoreLastSession() {
    if (restoreHasRun) return;
    restoreHasRun = true;

    const active = await getActiveSession();
    if (!active) return;

    console.log("Restoring last session:", active.folder, active.session);

    await restoreSession(active.folder, active.session);
}

chrome.runtime.onStartup.addListener(() => {
    setTimeout(() => tryRestoreLastSession(), 500);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    let handled = false;

    (async () => {
        if (msg.type === "CREATE_FOLDER" || msg.type === "SAVE_FOLDER") {
            await createFolder(msg.folderName);
            sendResponse({ success: true });
            handled = true;
        }

        if (msg.type === "SAVE_SESSION") {
            const existingFolders = await getFolders();
            if (!existingFolders[msg.folderName] && msg.folderName !== "") {
                await createFolder(msg.folderName);
            }
            const res = await saveCurrentSession(msg.folderName, msg.sessionName);
            if (msg.setActive) await setActiveSession(msg.folderName, msg.sessionName);
            sendResponse(res);
            handled = true;
        }

        if (msg.type === "RESTORE_SESSION") {
            await restoreSession(msg.folderName, msg.sessionName);
            sendResponse({ success: true });
            handled = true;
        }

        if (msg.type === "SET_ACTIVE_SESSION") {
            await setActiveSession(msg.folderName, msg.sessionName);
            sendResponse({ success: true });
            handled = true;
        }

        if (msg.type === "CREATE_AND_SWITCH_SESSION") {
            const folderName = msg.folderName || 'default';
            const sessionName = msg.sessionName;
            if (!sessionName) {
                sendResponse({ success: false, error: "sessionName required" });
                handled = true;
            } else {
                const r = await createAndSwitchToSession(folderName, sessionName);
                sendResponse(r);
                handled = true;
            }
        }

        if (msg.type === "DELETE_FOLDER") {
            const result = await deleteFolder(msg.folderName);
            sendResponse(result);
            handled = true;
        }

        if (msg.type === "DELETE_SESSION") {
            const result = await deleteSession(msg.folderName, msg.sessionName);
            sendResponse(result); 
            handled = true;
        }


        if (handled) return;
    })();

    return true;
});

chrome.tabs.onCreated.addListener(tab => {
    if (isRestoring) return;
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) return;

    try {
        updateTabInActiveSession(tab);
    } catch (e) {
        console.error("Autosave onCreated failed:", e);
    }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    if (isRestoring) return;

    chrome.tabs.get(tabId, (tab) => {
        try {
            if (tab && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
                updateTabInActiveSession(tab);
            }
        } catch (e) {
            console.error("Autosave onActivated update failed:", e);
        }
    });

    try {
        const active = await getActiveSession();
        if (!active) return;

        const sessions = await getSessionsInFolder(active.folder);
        const sessionTabs = sessions[active.session] || [];
        const idx = sessionTabs.findIndex(t => t.id === tabId);

        if (idx !== -1) {
            chrome.storage.local.set({ lastActiveTabIndex: idx });
        }
    } catch (e) {
        console.error("Saving active index failed:", e);
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (isRestoring) return;
    if (changeInfo.status === "complete" || changeInfo.title || changeInfo.favIconUrl) {
        try {
            if (!tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
                updateTabInActiveSession(tab);
            }
        } catch (e) {
            console.error("Autosave onUpdated failed:", e);
        }
    }
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    try {
        if (isRestoring) return;

        if (!changeInfo.status && !changeInfo.title && !changeInfo.favIconUrl) {
            return;
        }

        if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
            return;
        }

        const active = await getActiveSession();
        if (!active) return;     

        const win = await chrome.windows.getCurrent();
        if (tab.windowId !== win.id) return;

        await updateTabInActiveSession(tab);

    } catch (e) {
        console.error("Autosave onUpdated failed:", e);
    }
});



chrome.tabs.onRemoved.addListener((tabId) => {
    if (isRestoring) return;
    try {
        removeTabFromActiveSession(tabId);
    } catch (e) {
        console.error("Autosave onRemoved failed:", e);
    }
});

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
