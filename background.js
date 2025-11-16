import {
    createFolder, saveSession, setActiveSession, getActiveSession,
    getSessionsInFolder, updateTabInActiveSession, removeTabFromActiveSession,
    deleteFolder,
    deleteSession
} from "./storage.js";

let isRestoring = false;
let restoreHasRun = false;

function getFavicon(url) {
    try {
        const domain = new URL(url).origin;
        return `https://www.google.com/s2/favicons?sz=32&domain_url=${domain}`;
    } catch {
        return "";
    }
}

async function saveCurrentSession(folderName, sessionName) {
    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });

        const formatted = tabs.map(tab => ({
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

async function restoreSession(folderName, sessionName) {
    isRestoring = true;

    try {
        const sessions = await getSessionsInFolder(folderName);
        const tabs = sessions[sessionName] || [];
        if (!tabs.length) return;

        const win = await chrome.windows.getCurrent();
        const existingTabs = await chrome.tabs.query({ windowId: win.id });
        
        const firstTabId = existingTabs[0].id;
        
        const toRemove = existingTabs.slice(1).map(t => t.id).filter(id => id !== firstTabId);
        
        if (toRemove.length > 0) {
            await chrome.tabs.remove(toRemove);
        }

        await chrome.tabs.update(firstTabId, { url: tabs[0].url, active: true });
        
        for (let i = 1; i < tabs.length; i++) {
            if (!tabs[i].url || tabs[i].url.startsWith("chrome://") || tabs[i].url.startsWith("chrome-extension://")) continue; 
            await chrome.tabs.create({ url: tabs[i].url, windowId: win.id, active: false });
        }

        const { lastActiveTabIndex } = await chrome.storage.local.get("lastActiveTabIndex");
        const indexToActivate = lastActiveTabIndex ?? 0;

        const newList = await chrome.tabs.query({ windowId: win.id });
        if (newList[indexToActivate]) {
            chrome.tabs.update(newList[indexToActivate].id, { active: true });
        }

        await setActiveSession(folderName, sessionName);

    } catch (err) {
        console.error("Restore failed:", err);
    } finally {
        setTimeout(() => { isRestoring = false; }, 500);
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
        if (msg.type === "SAVE_SESSION") {
            await createFolder(msg.folderName);
            const res = await saveCurrentSession(msg.folderName, msg.sessionName);
            if (msg.setActive) await setActiveSession(msg.folderName, msg.sessionName);
            sendResponse(res);
            handled = true;
        }
    
        if (msg.type === "RESTORE_SESSION") {
            await setActiveSession(msg.folderName, msg.sessionName);
            await restoreSession(msg.folderName, msg.sessionName);
            sendResponse({ success: true });
            handled = true;
        }
    
        if (msg.type === "SET_ACTIVE_SESSION") {
            await setActiveSession(msg.folderName, msg.sessionName);
            sendResponse({ success: true });
            handled = true;
        }
        if (msg.type === "DELETE_FOLDER") {
            await deleteFolder(msg.folderName);
            sendResponse({ success: true });
            handled = true;
        }

        if (msg.type === "DELETE_SESSION") {
            await deleteSession(msg.folderName, msg.sessionName);
            sendResponse({ success: true });
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

chrome.tabs.onRemoved.addListener((tabId) => {
    if (isRestoring) return;
    try { 
        removeTabFromActiveSession(tabId); 
    } catch (e) {
        console.error("Autosave onRemoved failed:", e);
    }
});
