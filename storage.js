const STORAGE_KEY = "folders";
const ACTIVE_SESSION_KEY = "activeSession";
const ACTIVE_WINDOW_KEY = "activeSessionWindowId";

async function setActiveSessionWindowId(windowId) {
    return chrome.storage.local.set({ [ACTIVE_WINDOW_KEY]: windowId });
}

async function getActiveSessionWindowId() {
    const data = await chrome.storage.local.get([ACTIVE_WINDOW_KEY]);
    return data[ACTIVE_WINDOW_KEY] ?? null;
}

async function getAllFolders() {
    // retrieve folders from storage
    const data = await chrome.storage.local.get([STORAGE_KEY]);
    const folders = data[STORAGE_KEY] || {};

    for (const name in folders) {
        if (!folders[name].sessions) {
            folders[name].sessions = {};
        }
    }

    return folders;
}

async function saveFolders(folders) {
    return chrome.storage.local.set({ [STORAGE_KEY]: folders });
}

async function createFolder(folderName) {
    const folders = await getAllFolders();

    if (!folders[folderName]) {
        folders[folderName] = { sessions: {} };
        await saveFolders(folders);
    }
}

async function getFolders() {
    return await getAllFolders();
}

const SESSION_META_KEY = "sessionMeta"; // { "folderName/sessionName": lastModifiedTimestamp }

async function saveSession(folderName, sessionName, tabs) {
    const folders = await getAllFolders();
    if (!folders[folderName]) folders[folderName] = { sessions: {} };

    const normalized = (tabs || []).map(t => ({
        id: t.id || null,
        url: t.url || "",
        title: t.title || "",
        favicon: t.favicon || t.favIconUrl || "",
        active: !!t.active
    }));

    folders[folderName].sessions[sessionName] = normalized;
    await saveFolders(folders);

    const metaData = await chrome.storage.local.get([SESSION_META_KEY]);
    const meta = metaData[SESSION_META_KEY] || {};
    meta[`${folderName}/${sessionName}`] = Date.now();
    await chrome.storage.local.set({ [SESSION_META_KEY]: meta });
}

async function deleteSession(folderName, sessionName) {
    const active = await getActiveSession();

    if (active && active.folder === folderName && active.session === sessionName) {
        return { error: "ACTIVE_SESSION_DELETE_BLOCKED" };
    }

    const folders = await getAllFolders();

    if (folders[folderName]?.sessions?.[sessionName]) {
        delete folders[folderName].sessions[sessionName];
        await saveFolders(folders);
    }

    return { success: true };
}

async function renameSession(folderName, oldSessionName, newSessionName) {
    const folders = await getAllFolders();

    if (!folders[folderName]?.sessions?.[oldSessionName]) {
        return { success: false, error: "SESSION_NOT_FOUND" };
    }
    if (folders[folderName].sessions[newSessionName]) {
        return { success: false, error: "SESSION_NAME_EXISTS" };
    }

    folders[folderName].sessions[newSessionName] = folders[folderName].sessions[oldSessionName];
    delete folders[folderName].sessions[oldSessionName];
    await saveFolders(folders);

    const active = await getActiveSession();
    if (active && active.folder === folderName && active.session === oldSessionName) {
        await setActiveSession(folderName, newSessionName);
    }

    return { success: true };
}

async function duplicateSession(folderName, sessionName, newSessionName) {
    const folders = await getAllFolders();

    if (!folders[folderName]?.sessions?.[sessionName]) {
        return { success: false, error: "SESSION_NOT_FOUND" };
    }
    if (folders[folderName].sessions[newSessionName]) {
        return { success: false, error: "SESSION_NAME_EXISTS" };
    }

    const original = folders[folderName].sessions[sessionName];
    const copy = original.map(t => ({ ...t, id: null }));

    folders[folderName].sessions[newSessionName] = copy;
    await saveFolders(folders);

    return { success: true };
}


async function deleteFolder(folderName) {
    const active = await getActiveSession();

    if (active && active.folder === folderName) {
        return { error: "ACTIVE_FOLDER_DELETE_BLOCKED" };
    }

    const folders = await getAllFolders();

    if (folders[folderName]) {
        delete folders[folderName];
        await saveFolders(folders);
    }

    return { success: true };
}


async function getSessionsInFolder(folderName) {
    const folders = await getAllFolders();
    return folders[folderName]?.sessions || {};
}

async function setActiveSession(folderName, sessionName) {
    return chrome.storage.local.set({
        [ACTIVE_SESSION_KEY]: { folder: folderName, session: sessionName }
    });
}

async function getActiveSession() {
    const data = await chrome.storage.local.get([ACTIVE_SESSION_KEY]);
    const session = data[ACTIVE_SESSION_KEY];

    if (!session || !session.folder || !session.session) {
        return null;
    }

    return { folder: session.folder, session: session.session };
}

function findTabIndexById(sessionTabs, tab) {
    if (!Array.isArray(sessionTabs)) return -1;

    if (tab.id != null) {
        const byId = sessionTabs.findIndex(t => t.id === tab.id);
        if (byId !== -1) return byId;
    }

    return -1;
}

function findTabIndexByUrl(sessionTabs, tab) { 
    if (!Array.isArray(sessionTabs)) return -1;

    if (tab.url) {
        const byUrl = sessionTabs.findIndex(t => t.url === tab.url);
        if (byUrl !== -1) return byUrl;
    }

    return -1;
}

async function updateTabInActiveSession(tab, { source, changeInfo } = {}) {
    const active = await getActiveSession();
    if (!active) return;

    const { folder, session } = active;
    const folders = await getAllFolders();

    if (!folders[folder]?.sessions?.[session]) return;

    let sessionTabs = folders[folder].sessions[session];
    if (!Array.isArray(sessionTabs)) sessionTabs = [];

    // Fast exit for useless onUpdated events
    if (source === "updated" && changeInfo) {
        const hasMeaningfulChange =
            changeInfo.url ||
            changeInfo.title ||
            changeInfo.favIconUrl ||
            changeInfo.status === "complete";

        if (!hasMeaningfulChange) return;
    }

    let idx = findTabIndexById(sessionTabs, tab);

    // URL fallback ONLY during restore rebind
    if (idx === -1 && source === "updated" && tab.url) {
        idx = findTabIndexByUrl(sessionTabs, tab);
    }

    if (idx !== -1) {
        const existing = sessionTabs[idx];

        // Update fields only if they actually changed
        if (changeInfo?.url) existing.url = tab.url;
        if (changeInfo?.title) existing.title = tab.title;
        if (changeInfo?.favIconUrl) existing.favicon = tab.favIconUrl;

        // Always keep ID rebound
        if (tab.id != null) existing.id = tab.id;

        // Activation is special
        if (source === "activated") {
            existing.active = true;
        } else if (changeInfo?.status === "complete") {
            existing.active = !!tab.active;
        }
    }

    else {
        sessionTabs.push({
            id: tab.id ?? null,
            url: tab.url ?? "",
            title: tab.title ?? "",
            favicon: tab.favIconUrl ?? "",
            active: !!tab.active
        });
    }
    
    folders[folder].sessions[session] = sessionTabs;
    await saveFolders(folders);
}


async function removeTabFromActiveSession(tabId) {
    const active = await getActiveSession();
    if (!active) return;

    const { folder, session } = active;
    const folders = await getAllFolders();

    // Check if folder and session exist
    if (!folders[folder]?.sessions?.[session]) return;

    let sessionTabs = folders[folder].sessions[session];
    if (!Array.isArray(sessionTabs)) sessionTabs = [];

    // Removes the tab with the matching tabId
    sessionTabs = sessionTabs.filter(t => t.id !== tabId);

    folders[folder].sessions[session] = sessionTabs;
    await saveFolders(folders);
}

async function createNewTabInActiveSession(tab) {
    const active = await getActiveSession();
    if (!active) return;

    const folders = await getAllFolders();
    let sessionTabs = folders[active.folder].sessions[active.session] || [];

    // Prevent double insert for same tab.id
    if (sessionTabs.some(t => t.id === tab.id)) return;

    const newTab = {
        id: tab.id,
        url: tab.url || tab.pendingUrl || "",
        title: tab.title || "",
        favicon: tab.favIconUrl || "",
        active: !!tab.active
    };
    sessionTabs.splice(
        Math.min(tab.index ?? sessionTabs.length, sessionTabs.length),
        0,
        newTab
    );
    console.log("oncreated passed this point")

    folders[active.folder].sessions[active.session] = sessionTabs;
    await saveFolders(folders);
}

export {
    getAllFolders, getActiveSessionWindowId, setActiveSessionWindowId, saveFolders, createFolder, getFolders, saveSession,
    deleteSession, deleteFolder, getSessionsInFolder, setActiveSession, duplicateSession, renameSession,
    getActiveSession, updateTabInActiveSession, removeTabFromActiveSession, createNewTabInActiveSession
};