import React, { useEffect, useState, useCallback } from 'react';
import {
    Plus,
    Folder as FolderIcon,
    ExternalLink,
    Star,
    ChevronDown,
    X,
} from 'lucide-react';

function sendBg(msg) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(msg, (res) => {
                if (chrome.runtime.lastError) {
                    resolve({
                        success: false,
                        error: chrome.runtime.lastError.message,
                    });
                } else {
                    resolve(res);
                }
            });
        } catch (err) {
            resolve({ success: false, error: String(err) });
        }
    });
}

const StorageClient = {
    async getAll() {
        const data = await chrome.storage.local.get(['folders']);
        return data.folders || {};
    },
    async getLastFolder() {
        const data = await chrome.storage.local.get(['lastFolder']);
        return data.lastFolder;
    },
    async setLastFolder(folderName) {
        return chrome.storage.local.set({ lastFolder: folderName });
    },
    subscribe(callback) {
        function listener(changes, area) {
            if (area === 'local' && changes.folders) {
                callback(changes.folders.newValue || {});
            }
        }
        chrome.storage.onChanged.addListener(listener);
        return () => chrome.storage.onChanged.removeListener(listener);
    },
};

export default function App() {
    const [foldersObj, setFoldersObj] = useState({}); // { folderName: { sessions: { sessionName: [tabs] } } }
    const [allFolderNames, setAllFolderNames] = useState([]);
    const [selectedFolder, setSelectedFolder] = useState('default'); // only one folder visible at a time
    const [selectedSession, setSelectedSession] = useState(null); // session name string
    const [newSessionName, setNewSessionName] = useState('');
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [creatingFolder, setCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');

    const ensureDefaultFolder = useCallback(async (folders) => {
        if (!folders || typeof folders !== 'object') return;
        if (!Object.prototype.hasOwnProperty.call(folders, 'default')) {
            await sendBg({ type: 'CREATE_FOLDER', folderName: 'default' });
            const fresh = await StorageClient.getAll();
            setFoldersObj(fresh);
            setAllFolderNames(Object.keys(fresh));
        }
    }, []);

    const loadInitial = useCallback(async () => {
        const folders = await StorageClient.getAll();
        await ensureDefaultFolder(folders);
        const fresh = await StorageClient.getAll(); 
        setFoldersObj(fresh);
        const names = Object.keys(fresh);
        setAllFolderNames(names);

        // determine last folder
        const last = await StorageClient.getLastFolder();
        if (last && names.includes(last)) {
            setSelectedFolder(last);
        } else {
            setSelectedFolder('default');
            await StorageClient.setLastFolder('default');
        }

        const data = await chrome.storage.local.get(['activeSession']);
        const active = data.activeSession;
        if (
            active &&
            active.folder &&
            active.session &&
            active.folder === (last || 'default')
        ) {
            setSelectedSession(active.session);
        } else {
            setSelectedSession(null);
        }
    }, [ensureDefaultFolder]);

    useEffect(() => {
        loadInitial();
        const unsub = StorageClient.subscribe((newFolders) => {
            setFoldersObj(newFolders || {});
            setAllFolderNames(Object.keys(newFolders || {}));
            if (
                !Object.prototype.hasOwnProperty.call(
                    newFolders || {},
                    selectedFolder
                )
            ) {
                const keys = Object.keys(newFolders || {});
                const fallback = keys.includes('default')
                    ? 'default'
                    : keys[0] || 'default';
                setSelectedFolder(fallback);
                StorageClient.setLastFolder(fallback);
                setSelectedSession(null);
            }
        });
        return unsub;
    }, []);

    // When user selects folder from dropdown
    const handleSelectFolder = async (folderName) => {
        setDropdownOpen(false);
        setSelectedFolder(folderName);
        setSelectedSession(null); // clear session selection when switching folder
        await StorageClient.setLastFolder(folderName);
    };

    // Create folder inline
    const handleCreateFolder = async () => {
        const name = newFolderName && newFolderName.trim();
        if (!name) return;
        // do not allow 'default' to be created by user if exists (but allow other names)
        if (name === '') return;

        const res = await sendBg({ type: 'CREATE_FOLDER', folderName: name });
    
        if (res && res.success !== false) {
            setCreatingFolder(false);
            setNewFolderName('');
            setSelectedFolder(name);
            await StorageClient.setLastFolder(name);
            setSelectedSession(null);
        } else {
            alert(
                'Could not create folder: ' + (res?.error || 'unknown error')
            );
        }
    };

    // Add session: save empty session into current selected folder
    const addSession = async () => {
        const name = newSessionName && newSessionName.trim();
        if (!name) return alert('Enter a session name');

        const folderKey = selectedFolder || 'default';

        // Update storage directly (creating folder if necessary)
        const data = await chrome.storage.local.get(['folders']);
        const f = data.folders || {};
        if (!f[folderKey]) f[folderKey] = { sessions: {} };
        f[folderKey].sessions[name] = []; // empty session (will be filled when user saves current tabs or autosave runs)
        await chrome.storage.local.set({ folders: f });

        setNewSessionName('');
        // select the new session
        setSelectedSession(name);
        // set active session for background autosave
        await sendBg({
            type: 'SET_ACTIVE_SESSION',
            folderName: folderKey,
            sessionName: name,
        });
    };

    const deleteSession = async (sessionName) => {
        if (!confirm(`Delete session "${sessionName}"?`)) return;
        await sendBg({
            type: 'DELETE_SESSION',
            folderName: selectedFolder,
            sessionName,
        });
        if (selectedSession === sessionName) setSelectedSession(null);
    };

    const restoreSession = async (sessionName) => {
        if (
            !confirm(
                `Restore session "${sessionName}"? This will replace tabs in the current window.`
            )
        )
            return;
        await sendBg({
            type: 'RESTORE_SESSION',
            folderName: selectedFolder,
            sessionName,
        });
        await sendBg({
            type: 'SET_ACTIVE_SESSION',
            folderName: selectedFolder,
            sessionName,
        });
    };

    const deleteFolder = async (folderName) => {
        if (folderName === 'default') {
            alert('The default folder cannot be deleted.');
            return;
        }
        if (
            !confirm(
                `Delete folder "${folderName}" and all contained sessions?`
            )
        )
            return;
        await sendBg({ type: 'DELETE_FOLDER', folderName });
        setSelectedSession(null);
    };
    const sessionsForSelected = Object.keys(
        foldersObj[selectedFolder]?.sessions || {}
    );

    return (
        <div
            style={{
                display: 'flex',
                height: '100vh',
                fontFamily: 'Inter, system-ui, sans-serif',
            }}
        >
            {/* Sidebar */}
            <aside
                style={{
                    width: 340,
                    borderRight: '1px solid #e6e6e6',
                    padding: 18,
                    overflowY: 'auto',
                    background: '#fff',
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        marginBottom: 12,
                    }}
                >
                    <Star style={{ width: 20, height: 20, color: '#2563eb' }} />
                    <h1 style={{ fontSize: 18, margin: 0 }}>TabMax</h1>
                </div>

                {/* Folder selector (single folder visible at a time) */}
                <div style={{ marginBottom: 16 }}>
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                flex: 1,
                            }}
                        >
                            <FolderIcon
                                style={{
                                    width: 16,
                                    height: 16,
                                    color: '#2563eb',
                                }}
                            />
                            <div style={{ position: 'relative', flex: 1 }}>
                                <button
                                    onClick={() =>
                                        setDropdownOpen(!dropdownOpen)
                                    }
                                    style={{
                                        width: '100%',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        padding: '8px 10px',
                                        borderRadius: 8,
                                        border: '1px solid #e5e7eb',
                                        background: '#fff',
                                    }}
                                >
                                    <span
                                        style={{ textTransform: 'capitalize' }}
                                    >
                                        {selectedFolder || 'default'}
                                    </span>
                                    <ChevronDown
                                        style={{ width: 16, height: 16 }}
                                    />
                                </button>

                                {dropdownOpen && (
                                    <div
                                        style={{
                                            position: 'absolute',
                                            top: 'calc(100% + 6px)',
                                            left: 0,
                                            right: 0,
                                            background: '#fff',
                                            border: '1px solid #e5e7eb',
                                            borderRadius: 8,
                                            boxShadow:
                                                '0 6px 18px rgba(15, 23, 42, 0.08)',
                                            zIndex: 30,
                                            maxHeight: 260,
                                            overflowY: 'auto',
                                        }}
                                    >
                                        <div style={{ padding: 8 }}>
                                            {allFolderNames.length === 0 ? (
                                                <div
                                                    style={{
                                                        padding: 8,
                                                        color: '#6b7280',
                                                    }}
                                                >
                                                    No folders
                                                </div>
                                            ) : (
                                                allFolderNames.map((fn) => (
                                                    <div
                                                        key={fn}
                                                        style={{
                                                            display: 'flex',
                                                            alignItems:
                                                                'center',
                                                            justifyContent:
                                                                'space-between',
                                                            padding: '8px',
                                                            borderRadius: 6,
                                                        }}
                                                    >
                                                        <div
                                                            onClick={() =>
                                                                handleSelectFolder(
                                                                    fn
                                                                )
                                                            }
                                                            style={{
                                                                cursor: 'pointer',
                                                                paddingRight: 8,
                                                            }}
                                                        >
                                                            {fn}
                                                        </div>
                                                    </div>
                                                ))
                                            )}
                                        </div>

                                        {/* create new folder toggle inside dropdown */}
                                        <div
                                            style={{
                                                padding: 8,
                                                borderTop: '1px solid #f1f5f9',
                                                display: 'flex',
                                                gap: 8,
                                            }}
                                        >
                                            {creatingFolder ? (
                                                <>
                                                    <input
                                                        value={newFolderName}
                                                        onChange={(e) =>
                                                            setNewFolderName(
                                                                e.target.value
                                                            )
                                                        }
                                                        placeholder="Folder name"
                                                        onKeyDown={(e) => {
                                                            if (
                                                                e.key ===
                                                                'Enter'
                                                            )
                                                                handleCreateFolder();
                                                            if (
                                                                e.key ===
                                                                'Escape'
                                                            ) {
                                                                setCreatingFolder(
                                                                    false
                                                                );
                                                                setNewFolderName(
                                                                    ''
                                                                );
                                                            }
                                                        }}
                                                        style={{
                                                            flex: 1,
                                                            padding: '8px 10px',
                                                            borderRadius: 6,
                                                            border: '1px solid #e5e7eb',
                                                        }}
                                                    />
                                                    <button
                                                        onClick={
                                                            handleCreateFolder
                                                        }
                                                        style={{
                                                            padding: '8px 10px',
                                                            borderRadius: 6,
                                                            background:
                                                                '#2563eb',
                                                            color: '#fff',
                                                            border: 'none',
                                                        }}
                                                    >
                                                        Create
                                                    </button>
                                                    <button
                                                        onClick={() => {
                                                            setCreatingFolder(
                                                                false
                                                            );
                                                            setNewFolderName(
                                                                ''
                                                            );
                                                        }}
                                                        style={{
                                                            padding: '8px',
                                                            borderRadius: 6,
                                                            border: '1px solid #e5e7eb',
                                                            background: '#fff',
                                                        }}
                                                    >
                                                        <X />
                                                    </button>
                                                </>
                                            ) : (
                                                <button
                                                    onClick={() =>
                                                        setCreatingFolder(true)
                                                    }
                                                    style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: 8,
                                                        padding: '8px 10px',
                                                        borderRadius: 6,
                                                        border: '1px solid #e5e7eb',
                                                        background: '#fff',
                                                    }}
                                                >
                                                    <Plus
                                                        style={{
                                                            width: 12,
                                                            height: 12,
                                                        }}
                                                    />{' '}
                                                    New folder
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* New session input (creates session inside currently selected folder) */}
                <div
                    style={{
                        marginBottom: 12,
                        background: '#f8fafc',
                        padding: 10,
                        borderRadius: 8,
                    }}
                >
                    <input
                        value={newSessionName}
                        onChange={(e) => setNewSessionName(e.target.value)}
                        placeholder="New session name (saved into selected folder)"
                        style={{
                            width: '100%',
                            padding: '8px 10px',
                            borderRadius: 6,
                            border: '1px solid #ddd',
                            marginBottom: 8,
                        }}
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            onClick={addSession}
                            style={{
                                flex: 1,
                                padding: 8,
                                background: '#2563eb',
                                color: '#fff',
                                border: 'none',
                                borderRadius: 6,
                            }}
                        >
                            <span
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 8,
                                }}
                            >
                                <Plus style={{ width: 14, height: 14 }} /> Add
                                Session
                            </span>
                        </button>
                        <button
                            onClick={() => {
                                // Save current tabs into a session in the selected folder via background SAVE_SESSION
                                const sessionPrompt = prompt(
                                    'Name for session to save current window tabs:'
                                );
                                if (!sessionPrompt) return;
                                // If the selectedFolder is 'default' ensure background can handle it — background SAVE_SESSION will create folder if needed
                                sendBg({
                                    type: 'SAVE_SESSION',
                                    folderName: selectedFolder || 'default',
                                    sessionName: sessionPrompt,
                                    setActive: true,
                                });
                            }}
                            style={{
                                padding: 8,
                                borderRadius: 6,
                                border: '1px solid #ddd',
                                background: '#fff',
                            }}
                        >
                            Save current tabs
                        </button>
                    </div>
                </div>

                {/* Sessions list (for selected folder only) */}
                <div
                    style={{ marginBottom: 8, color: '#6b7280', fontSize: 12 }}
                >
                    SESSIONS in <strong>{selectedFolder}</strong>
                </div>

                <div>
                    {sessionsForSelected.length === 0 ? (
                        <div style={{ color: '#6b7280' }}>
                            No sessions in this folder.
                        </div>
                    ) : (
                        sessionsForSelected.map((sessionName) => (
                            <div
                                key={sessionName}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    marginBottom: 8,
                                }}
                            >
                                <div
                                    onClick={async () => {
                                        setSelectedSession(sessionName);
                                        // set as active so autosave works
                                        await sendBg({
                                            type: 'SET_ACTIVE_SESSION',
                                            folderName: selectedFolder,
                                            sessionName,
                                        });
                                    }}
                                    style={{
                                        cursor: 'pointer',
                                        padding: '8px 10px',
                                        borderRadius: 8,
                                        background:
                                            selectedSession === sessionName
                                                ? '#e0f2fe'
                                                : '#fff',
                                        flex: 1,
                                    }}
                                >
                                    {sessionName}
                                </div>

                                <div
                                    style={{
                                        display: 'flex',
                                        gap: 8,
                                        marginLeft: 8,
                                    }}
                                >
                                    <button
                                        onClick={() =>
                                            restoreSession(sessionName)
                                        }
                                        title="Restore"
                                    >
                                        Restore
                                    </button>
                                    <button
                                        onClick={() =>
                                            deleteSession(sessionName)
                                        }
                                        title="Delete"
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </aside>

            {/* Main area: tabs for selected session */}
            <main style={{ flex: 1, padding: 20, overflowY: 'auto' }}>
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 20,
                    }}
                >
                    <h2 style={{ margin: 0 }}>
                        {selectedSession
                            ? `${selectedSession}`
                            : 'Select a session'}
                    </h2>
                    <div style={{ color: '#6b7280' }} />
                </div>

                <div>
                    {selectedSession ? (
                        (() => {
                            const folderKey = selectedFolder || 'default';
                            const tabs =
                                foldersObj[folderKey]?.sessions?.[
                                    selectedSession
                                ] || [];
                            if (!tabs || tabs.length === 0) {
                                return (
                                    <div style={{ color: '#6b7280' }}>
                                        This session has no saved tabs.
                                    </div>
                                );
                            }
                            return (
                                <div style={{ display: 'grid', gap: 12 }}>
                                    {tabs.map((tab, idx) => (
                                        <div
                                            key={idx}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                padding: 12,
                                                borderRadius: 8,
                                                border: '1px solid #e6e6e6',
                                                background: '#fff',
                                            }}
                                        >
                                            <div>
                                                <div
                                                    style={{ fontWeight: 600 }}
                                                >
                                                    {tab.title || tab.url}
                                                </div>
                                                <div
                                                    style={{
                                                        color: '#6b7280',
                                                        fontSize: 13,
                                                    }}
                                                >
                                                    {tab.url}
                                                </div>
                                            </div>
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    gap: 8,
                                                }}
                                            >
                                                <a
                                                    href={tab.url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    title="Open"
                                                >
                                                    <ExternalLink
                                                        style={{
                                                            width: 16,
                                                            height: 16,
                                                        }}
                                                    />
                                                </a>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            );
                        })()
                    ) : (
                        <div style={{ color: '#6b7280' }}>
                            Choose a session from the left to view its tabs.
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
