import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Folder, Layers, ExternalLink, Star } from 'lucide-react';

// Helper: send message to background and return promise
function sendBg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res);
        }
      });
    } catch (err) {
      resolve({ success: false, error: String(err) });
    }
  });
}

// Direct storage reader/writer wrapper
const StorageClient = {
  async getAll() {
    const data = await chrome.storage.local.get(['folders']);
    return data.folders || {};
  },
  subscribe(callback) {
    // callback will be called with new folders whenever storage changes
    function listener(changes, area) {
      if (area === 'local' && changes.folders) {
        callback(changes.folders.newValue || {});
      }
    }
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
};

export default function App() {
  const [foldersObj, setFoldersObj] = useState({}); // { folderName: { sessions: { sessionName: [tabs] } } }
  const [selectedSession, setSelectedSession] = useState({ folder: null, session: null });
  const [newSessionName, setNewSessionName] = useState('');
  const [selectedFolderForNew, setSelectedFolderForNew] = useState('none'); // 'none' means no folder
  const [allFolderNames, setAllFolderNames] = useState([]);

  // load initial storage
  const loadFolders = useCallback(async () => {
    const folders = await StorageClient.getAll();
    setFoldersObj(folders);
    setAllFolderNames(Object.keys(folders));
  }, []);

  useEffect(() => {
    loadFolders();
    const unsub = StorageClient.subscribe((newFolders) => {
      setFoldersObj(newFolders || {});
      setAllFolderNames(Object.keys(newFolders || {}));
    });
    return unsub;
  }, [loadFolders]);

  // When a session is selected, update active session in storage so background autosave picks it up
  const setActive = async (folder, session) => {
    setSelectedSession({ folder, session });
    if (folder && session) {
      await sendBg({ type: 'SET_ACTIVE_SESSION', folderName: folder, sessionName: session });
    }
  };

  // Create folder
  const createFolder = async (name) => {
    if (!name) return;
    await sendBg({ type: 'CREATE_FOLDER', folderName: name });
    // storage change listener will pick up change
  };

  // Add session inline (no modal). If selectedFolderForNew === 'none', create session at root (no folder)
  const addSession = async () => {
    const name = newSessionName && newSessionName.trim();
    if (!name) return alert('Enter a session name');

    const folderName = selectedFolderForNew === 'none' ? null : selectedFolderForNew;

    if (!folderName) {
      // Save session at root: we will create a pseudo-folder key "" or store sessions under a special key.
      // Your storage.js uses a folders object mapping folderName -> { sessions: {} }
      // We will name the root folder as "__ROOT__" internally to avoid changing storage shape.
      // But simpler: create a folder named "__ROOT__" if not present and store sessions there, or
      // better: store sessions under a top-level special folder name like "" (empty string) — your existing storage uses object keys, so empty string is acceptable.
      const targetFolder = ''; // empty string represents no-folder
      // Ensure folder exists and then call save session via background SAVE_SESSION (which uses createFolder inside)
      await sendBg({ type: 'CREATE_FOLDER', folderName: targetFolder });
      // The background save flow expects current window tabs. But we want to create an empty named session (no tabs) — so use chrome.storage directly:
      // Read current folders, update folders object with session value set to [].
      const folders = await chrome.storage.local.get(['folders']);
      const f = folders.folders || {};
      if (!f[targetFolder]) f[targetFolder] = { sessions: {} };
      f[targetFolder].sessions[name] = [];
      await chrome.storage.local.set({ folders: f });
      setNewSessionName('');
      setSelectedFolderForNew('none');
      setSelectedSession({ folder: targetFolder, session: name });
      return;
    }

    // If folderName exists, create session there with empty tabs
    // Your background's SAVE_SESSION uses active tab list — to create an empty session we must update storage directly:
    const folders = await chrome.storage.local.get(['folders']);
    const f = folders.folders || {};
    if (!f[folderName]) f[folderName] = { sessions: {} };
    f[folderName].sessions[name] = [];
    await chrome.storage.local.set({ folders: f });
    setNewSessionName('');
    setSelectedFolderForNew('none');
    setSelectedSession({ folder: folderName, session: name });
  };

  // Delete session
  const deleteSession = async (folder, session) => {
    if (!confirm(`Delete session "${session}"?`)) return;
    await sendBg({ type: 'DELETE_SESSION', folderName: folder, sessionName: session });
  };

  // Delete folder (and all its sessions)
  const deleteFolder = async (folder) => {
    if (!confirm(`Delete folder "${folder}" and all contained sessions?`)) return;
    await sendBg({ type: 'DELETE_FOLDER', folderName: folder });
  };

  // Restore a session (calls background restore flow)
  const restoreSession = async (folder, session) => {
    if (!confirm(`Restore session "${session}"? This will replace tabs in the current window.`)) return;
    await sendBg({ type: 'RESTORE_SESSION', folderName: folder, sessionName: session });
  };

  // Build a simple derived data model: array of folder groups with sessions, plus no-folder group
  const folderNames = Object.keys(foldersObj);
  const rootGroup = (foldersObj['']?.sessions) ? Object.keys(foldersObj[''].sessions) : [];

  return (
    <div className="app-root" style={{ display: 'flex', height: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <aside style={{ width: 320, borderRight: '1px solid #e6e6e6', padding: 18, overflowY: 'auto', background: '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Star style={{ width: 20, height: 20, color: '#2563eb' }} />
          <h1 style={{ fontSize: 18, margin: 0 }}>TabMax</h1>
        </div>

        {/* New session input */}
        <div style={{ marginBottom: 12, background: '#f8fafc', padding: 10, borderRadius: 8 }}>
          <input
            value={newSessionName}
            onChange={(e) => setNewSessionName(e.target.value)}
            placeholder="New session name"
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ddd', marginBottom: 8 }}
          />

          <select
            value={selectedFolderForNew}
            onChange={(e) => setSelectedFolderForNew(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ddd', marginBottom: 8 }}
          >
            <option value="none">No folder</option>
            {folderNames.map((fn) => fn !== '' && <option key={fn} value={fn}>{fn}</option>)}
          </select>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={addSession} style={{ flex: 1, padding: 8, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Plus style={{ width: 14, height: 14 }} /> Add Session</span>
            </button>
            <button onClick={() => {
              const name = prompt('New folder name:');
              if (name) createFolder(name.trim());
            }} style={{ padding: 8, borderRadius: 6, border: '1px solid #ddd', background: '#fff' }}>
              <Folder style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>

        {/* Sessions listing: No-Folder group then folders */}
        <div style={{ marginBottom: 8, color: '#6b7280', fontSize: 12 }}>SESSIONS</div>

        {/* No-folder sessions (stored under folder key '') */}
        {rootGroup.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#374151', marginBottom: 6 }}>
              <Layers style={{ width: 14, height: 14 }} /> No Folder
            </div>
            {rootGroup.map(name => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div onClick={() => setActive(name === '' ? '' : '', name)} style={{ cursor: 'pointer', padding: '8px 10px', borderRadius: 8, background: selectedSession.folder === '' && selectedSession.session === name ? '#e0f2fe' : '#f8fafc' }}>
                  {name}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => restoreSession('', name)} title="Restore">Restore</button>
                  <button onClick={() => deleteSession('', name)} title="Delete">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Folders */}
        {folderNames.filter(fn => fn !== '').map(folderName => {
          const sessions = Object.keys((foldersObj[folderName]?.sessions) || {});
          return (
            <div key={folderName} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Folder style={{ width: 14, height: 14, color: '#2563eb' }} />
                  <div style={{ fontWeight: 600 }}>{folderName}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => deleteFolder(folderName)} title="Delete folder">Del</button>
                </div>
              </div>

              {sessions.length === 0 ? <div style={{ color: '#9ca3af', marginLeft: 6 }}>Empty</div> : sessions.map(sessionName => (
                <div key={sessionName} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div onClick={() => setActive(folderName, sessionName)} style={{ cursor: 'pointer', padding: '8px 10px', borderRadius: 8, background: selectedSession.folder === folderName && selectedSession.session === sessionName ? '#e0f2fe' : '#fff' }}>
                    {sessionName}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => restoreSession(folderName, sessionName)} title="Restore">Restore</button>
                    <button onClick={() => deleteSession(folderName, sessionName)} title="Delete">Delete</button>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </aside>

      <main style={{ flex: 1, padding: 20, overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0 }}>{selectedSession.session ? `${selectedSession.session}` : 'Select a session'}</h2>
          <div style={{ color: '#6b7280' }}>{/* placeholder for stats */}</div>
        </div>

        {/* Display tabs for the currently selected session */}
        <div>
          {selectedSession.session ? (
            (() => {
              const folderKey = selectedSession.folder ?? '';
              const tabs = (foldersObj[folderKey]?.sessions?.[selectedSession.session]) || [];
              if (tabs.length === 0) {
                return <div style={{ color: '#6b7280' }}>This session has no saved tabs.</div>;
              }
              return (
                <div style={{ display: 'grid', gap: 12 }}>
                  {tabs.map((tab, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 8, border: '1px solid #e6e6e6', background: '#fff' }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{tab.title || tab.url}</div>
                        <div style={{ color: '#6b7280', fontSize: 13 }}>{tab.url}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <a href={tab.url} target="_blank" rel="noreferrer" title="Open"><ExternalLink style={{ width: 16, height: 16 }} /></a>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()
          ) : (
            <div style={{ color: '#6b7280' }}>Choose a session from the left to view its tabs.</div>
          )}
        </div>
      </main>
    </div>
  );
}
