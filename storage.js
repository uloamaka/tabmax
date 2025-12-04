const STORAGE_KEY = "folders";
const ACTIVE_SESSION_KEY = "activeSession";

async function getAllFolders() {
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

async function saveSession(folderName, sessionName, tabs) {
    const folders = await getAllFolders();

    if (!folders[folderName]) {
        folders[folderName] = { sessions: {} };
    }

    const normalized = (tabs || []).map(t => ({
        id: t.id || null,
        url: t.url || "",
        title: t.title || "",
        favicon: t.favicon || t.favIconUrl || "",
        active: !!t.active
    }));

    folders[folderName].sessions[sessionName] = normalized;
    await saveFolders(folders);
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

function findTabIndexByIdOrUrl(sessionTabs, tab) {
    if (!Array.isArray(sessionTabs)) return -1;

    if (tab.id != null) {
        const byId = sessionTabs.findIndex(t => t.id === tab.id);
        if (byId !== -1) return byId;
    }

    if (tab.url) {
        const byUrl = sessionTabs.findIndex(t => t.url === tab.url);
        if (byUrl !== -1) return byUrl;
    }

    return -1;
}


async function updateTabInActiveSession(tab) {
    const active = await getActiveSession();
    if (!active) return;

    const { folder, session } = active;
    const folders = await getAllFolders();

    if (!folders[folder]?.sessions?.[session]) return;

    let sessionTabs = folders[folder].sessions[session];
    if (!Array.isArray(sessionTabs)) sessionTabs = [];

    const idx = findTabIndexByIdOrUrl(sessionTabs, tab);

    if (idx !== -1) {
        Object.assign(sessionTabs[idx], {
            id: tab.id || sessionTabs[idx].id,
            url: tab.url || sessionTabs[idx].url,
            title: tab.title || sessionTabs[idx].title,
            favicon: tab.favIconUrl || sessionTabs[idx].favicon,
            active: !!tab.active
        });
    } else {
        sessionTabs.push({
            id: tab.id || null,
            url: tab.url || "",
            title: tab.title || "",
            favicon: tab.favIconUrl || "",
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

    if (!folders[folder]?.sessions?.[session]) return;

    let sessionTabs = folders[folder].sessions[session];
    if (!Array.isArray(sessionTabs)) sessionTabs = [];

    sessionTabs = sessionTabs.filter(t => t.id !== tabId);

    folders[folder].sessions[session] = sessionTabs;
    await saveFolders(folders);
}

export {
    getAllFolders, saveFolders, createFolder, getFolders, saveSession,
    deleteSession, deleteFolder, getSessionsInFolder, setActiveSession,
    getActiveSession, updateTabInActiveSession, removeTabFromActiveSession
};