const folderListEl = document.getElementById("folder-list");
const saveSessionBtn = document.getElementById("save-session-btn");
const newFolderBtn = document.getElementById("new-folder-btn");

async function renderFolders() {
    const folders = await getFolders();
    folderListEl.innerHTML = "";

    Object.keys(folders).forEach(folderName => {
        const folderDiv = document.createElement("div");
        folderDiv.className = "folder";

        const title = document.createElement("div");
        title.className = "folder-title";
        title.textContent = folderName;
        title.onclick = () => toggleFolder(folderName);

        const delBtn = document.createElement("button");
        delBtn.textContent = "Delete Folder";
        delBtn.onclick = async (e) => {
            e.stopPropagation();
            await deleteFolder(folderName);
            renderFolders();
        };

        folderDiv.appendChild(title);
        folderDiv.appendChild(delBtn);

        const sessionsWrap = document.createElement("div");
        sessionsWrap.id = `sessions-${folderName}`;
        sessionsWrap.style.display = "none";

        const sessions = folders[folderName].sessions;

        Object.keys(sessions).forEach(sessionName => {
            const row = document.createElement("div");
            row.className = "session-item";

            const label = document.createElement("span");
            label.textContent = sessionName;

            const restoreBtn = document.createElement("button");
            restoreBtn.textContent = "Open";
            restoreBtn.onclick = () => restoreSession(folderName, sessionName);

            const delSessionBtn = document.createElement("button");
            delSessionBtn.textContent = "X";
            delSessionBtn.onclick = async () => {
                await deleteSession(folderName, sessionName);
                renderFolders();
            };

            const actions = document.createElement("div");
            actions.appendChild(restoreBtn);
            actions.appendChild(delSessionBtn);

            row.appendChild(label);
            row.appendChild(actions);
            sessionsWrap.appendChild(row);
        });

        folderDiv.appendChild(sessionsWrap);
        folderListEl.appendChild(folderDiv);
    });
}

function toggleFolder(folderName) {
    const el = document.getElementById(`sessions-${folderName}`);
    el.style.display = el.style.display === "none" ? "block" : "none";
}

function restoreSession(folderName, sessionName) {
    chrome.runtime.sendMessage({
        type: "RESTORE_SESSION",
        folderName,
        sessionName
    });
}

saveSessionBtn.onclick = async () => {
    const folderName = prompt("Folder name:", "Default");
    if (!folderName) return;

    const sessionName = prompt("Session name:", new Date().toLocaleString());
    if (!sessionName) return;

    chrome.runtime.sendMessage({
        type: "SAVE_SESSION",
        folderName,
        sessionName
    }, async () => {
        await createFolder(folderName);
        renderFolders();
        alert("Session saved!");
    });
};

newFolderBtn.onclick = async () => {
    const folderName = prompt("New folder name:");
    if (!folderName) return;

    await createFolder(folderName);
    renderFolders();
};

renderFolders();

