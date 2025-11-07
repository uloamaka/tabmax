importScripts("storage.js");

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
    return new Promise(resolve => {
        chrome.tabs.query({ currentWindow: true }, async (tabs) => {
            const formatted = tabs.map(tab => ({
                id: tab.id,
                url: tab.url || "",
                title: tab.title || "",
                favicon: tab.favIconUrl || getFavicon(tab.url),
                active: !!tab.active
            }));

            await saveSession(folderName, sessionName, formatted);
            resolve({ success: true });
        });
    });
}

async function restoreSession(folderName, sessionName) {
    isRestoring = true;

    try {
        const sessions = await getSessionsInFolder(folderName);
        const tabs = sessions[sessionName] || [];
        if (!tabs.length) return;

        const win = await chrome.windows.getCurrent();
        const existingTabs = await chrome.tabs.query({ windowId: win.id });

        if (existingTabs.length > 1) {
            const toRemove = existingTabs.slice(1).map(t => t.id);
            await chrome.tabs.remove(toRemove);

            chrome.tabs.update(existingTabs[0].id, { url: tabs[0].url, active: true });

            for (let i = 1; i < tabs.length; i++) {
                if (!tabs[i].url || tabs[i].url.startsWith("chrome://")) continue;
                await chrome.tabs.create({ url: tabs[i].url, windowId: win.id, active: false });
            }
        } else {
            chrome.tabs.update(existingTabs[0].id, { url: tabs[0].url, active: true });

            for (let i = 1; i < tabs.length; i++) {
                if (!tabs[i].url || tabs[i].url.startsWith("chrome://")) continue;
                await chrome.tabs.create({ url: tabs[i].url, windowId: win.id, active: false });
            }
        }

        const { lastActiveTabIndex } = await chrome.storage.local.get("lastActiveTabIndex");
        const index = lastActiveTabIndex ?? 0;

        const newList = await chrome.tabs.query({ windowId: win.id });
        if (newList[index]) {
            chrome.tabs.update(newList[index].id, { active: true });
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
    if (msg.type === "SAVE_SESSION") {
        (async () => {
            await createFolder(msg.folderName);
            const res = await saveCurrentSession(msg.folderName, msg.sessionName);
            if (msg.setActive) await setActiveSession(msg.folderName, msg.sessionName);
            sendResponse(res);
        })();
        return true;
    }

    if (msg.type === "RESTORE_SESSION") {
        (async () => {
            await setActiveSession(msg.folderName, msg.sessionName);
            await restoreSession(msg.folderName, msg.sessionName);
            sendResponse({ success: true });
        })();
        return true;
    }

    if (msg.type === "SET_ACTIVE_SESSION") {
        (async () => {
            await setActiveSession(msg.folderName, msg.sessionName);
            sendResponse({ success: true });
        })();
        return true;
    }
});

chrome.tabs.onCreated.addListener(tab => {
    if (isRestoring) return;
    try { addTabToActiveSession(tab); } catch {}
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    if (isRestoring) return;

    chrome.tabs.get(tabId, (tab) => {
        try { updateTabInActiveSession(tab); } catch {}
    });

    const active = await getActiveSession();
    if (!active) return;

    const sessions = await getSessionsInFolder(active.folder);
    const sessionTabs = sessions[active.session] || [];
    const idx = sessionTabs.findIndex(t => t.id === tabId);

    if (idx !== -1) {
        chrome.storage.local.set({ lastActiveTabIndex: idx });
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (isRestoring) return;
    if (changeInfo.status === "complete" || changeInfo.title || changeInfo.favIconUrl) {
        try { updateTabInActiveSession(tab); } catch {}
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (isRestoring) return;
    try { removeTabFromActiveSession(tabId); } catch {}
});
