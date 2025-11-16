document.addEventListener("DOMContentLoaded", () => {
    const mainView = document.getElementById("mainView");
    const sessionDetailView = document.getElementById("sessionDetailView");
    const folderListEl = document.getElementById("folderList");
    const sessionDetailTitleEl = document.getElementById("sessionDetailTitle");
    const sessionTabsListEl = document.getElementById("sessionTabsList");
    const saveSessionBtn = document.getElementById("saveSessionBtn"); 
    const newFolderBtn = document.getElementById("newFolderBtn");
    const activeSessionStatusEl = document.getElementById("activeSessionStatus");
    const backToFoldersBtn = document.getElementById("backToFoldersBtn");
    const restoreDetailBtn = document.getElementById("restoreDetailBtn");

    let currentActiveSession = null;
    let activeSessionContext = { folder: null, session: null };

    function sendMessage(msg) {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                console.warn("Message sent but no response within 5 seconds.");
                resolve({ success: false, error: "Timeout or service worker unavailable." });
            }, 5000);

            chrome.runtime.sendMessage(msg, (response) => {
                clearTimeout(timeoutId);

                if (chrome.runtime.lastError) {
                    resolve({ success: false, error: chrome.runtime.lastError.message });
                } else {
                    resolve(response);
                }
            });
        });
    }

    function updateActiveStatus() {
        if (currentActiveSession?.folder && currentActiveSession?.session) {
            activeSessionStatusEl.innerHTML = `
                Autosaving to:
                <span class="font-bold text-indigo-300">
                    ${currentActiveSession.folder} / ${currentActiveSession.session}
                </span>`;
        } else {
            activeSessionStatusEl.textContent = "No active session being monitored.";
        }
    }

    async function renderFolders() {
        mainView.style.display = "block";
        sessionDetailView.style.display = "none";

        let folders = {};

        try {
            const data = await chrome.storage.local.get(["folders", "activeSession"]);
            folders = data.folders || {};
            currentActiveSession = data.activeSession || null;
        } catch (err) {
            folderListEl.innerHTML = `<p class="error">Error loading sessions.</p>`;
            return;
        }

        folderListEl.innerHTML = "";
        updateActiveStatus();

        Object.keys(folders).forEach(folderName => {
            const folderDiv = document.createElement("div");
            folderDiv.className = "folder";

            const header = document.createElement("div");
            header.className = "folder-header";
            header.innerHTML = `
                <span>${folderName}</span>
                <button class="delete-folder">✖</button>
            `;

            header.onclick = (e) => {
                if (!e.target.closest("button")) {
                    toggleFolder(folderName);
                }
            };

            header.querySelector(".delete-folder").onclick = async (e) => {
                e.stopPropagation();
                if (confirm(`Delete folder "${folderName}" and all its sessions?`)) {
                    await sendMessage({ type: "DELETE_FOLDER", folderName });
                    renderFolders();
                }
            };

            const sessionsWrap = document.createElement("div");
            sessionsWrap.id = `sessions-${folderName}`;
            sessionsWrap.className = "session-group";
            sessionsWrap.style.display = "none";

            const sessions = folders[folderName].sessions;

            Object.keys(sessions).forEach(sessionName => {
                const row = document.createElement("div");
                row.className = "session-row";
                row.textContent = sessionName;
                row.onclick = () => showSessionDetail(folderName, sessionName);

                sessionsWrap.appendChild(row);
            });

            folderDiv.appendChild(header);
            folderDiv.appendChild(sessionsWrap);
            folderListEl.appendChild(folderDiv);
        });
    }

    async function showSessionDetail(folderName, sessionName) {
        mainView.style.display = "none";
        sessionDetailView.style.display = "block";

        activeSessionContext = { folder: folderName, session: sessionName };
        sessionDetailTitleEl.textContent = `${folderName} / ${sessionName}`;

        const data = await chrome.storage.local.get("folders");
        const sessionTabs = data.folders?.[folderName]?.sessions?.[sessionName] || [];

        sessionTabsListEl.innerHTML = "";

        if (sessionTabs.length === 0) {
            sessionTabsListEl.innerHTML = `<p>No saved tabs.</p>`;
            return;
        }

        sessionTabs.forEach(tab => {
            const item = document.createElement("li");
            item.className = "tab-item";
            item.textContent = tab.title || tab.url;
            item.onclick = () => chrome.tabs.create({ url: tab.url });

            sessionTabsListEl.appendChild(item);
        });
    }

    function toggleFolder(folderName) {
        const el = document.getElementById(`sessions-${folderName}`);
        el.style.display = (el.style.display === "none" ? "block" : "none");
    }

    function restoreSession(folderName, sessionName) {
        sendMessage({ type: "RESTORE_SESSION", folderName, sessionName });
        window.close();
    }

    backToFoldersBtn.onclick = () => renderFolders();

    restoreDetailBtn.onclick = () => {
        const { folder, session } = activeSessionContext;
        if (folder && session) {
            if (confirm(`Restore "${session}" now?`)) {
                restoreSession(folder, session);
            }
        }
    };

    newFolderBtn.onclick = async () => {
        const name = prompt("Folder name:");
        if (!name) return;

        await sendMessage({ type: "CREATE_FOLDER", folderName: name });
        renderFolders();
    };

    if (saveSessionBtn) {
        saveSessionBtn.onclick = async () => {
            const folderName = prompt("Folder name:");
            if (!folderName) return;

            const sessionName = prompt("Session name:");
            if (!sessionName) return;

            await sendMessage({
                type: "SAVE_SESSION",
                folderName,
                sessionName,
                setActive: true
            });

            renderFolders();
        };
    }

    renderFolders();
});
