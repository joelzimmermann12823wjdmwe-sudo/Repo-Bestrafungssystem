const RECORDINGS_ENDPOINT = '/api/recordings';
const STATUS_ENDPOINT = '/api/status';

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDateTime(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function sanitizeName(name) {
    return name.replace(/^USER_/, '').replace(/_/g, ' ').replace('.wav', '');
}

function showLoading() {
    const loading = document.getElementById('loading');
    const list = document.getElementById('recordings-list');
    const empty = document.getElementById('empty-state');
    loading.classList.remove('hidden');
    list.classList.add('hidden');
    empty.classList.add('hidden');
}

function hideLoading() {
    document.getElementById('loading').classList.add('hidden');
}

async function loadRecordings() {
    showLoading();

    try {
        const res = await fetch(RECORDINGS_ENDPOINT);
        if (!res.ok) {
            if (res.status === 401) {
                window.location.href = '/login';
                return;
            }
            throw new Error('Serverfehler (' + res.status + ')');
        }
        const data = await res.json();
        hideLoading();

        if (data.folders.length === 0) {
            document.getElementById('empty-state').classList.remove('hidden');
            return;
        }

        document.getElementById('recordings-list').classList.remove('hidden');
        renderRecordings(data.folders);
    } catch (err) {
        hideLoading();
        document.getElementById('loading').innerHTML = '<p class="error">Fehler: ' + escapeHtml(err.message) + '</p>';
    }
}

async function updateStatus() {
    try {
        const res = await fetch(STATUS_ENDPOINT);
        if (!res.ok) {
            if (res.status === 401) {
                window.location.href = '/login';
                return;
            }
            return;
        }
        const data = await res.json();

        const statusBadge = document.getElementById('bot-status');
        const activeBadge = document.getElementById('active-recordings');

        if (data.bot !== 'offline') {
            statusBadge.textContent = data.bot;
            statusBadge.className = 'status-badge online';
        } else {
            statusBadge.textContent = 'Bot offline';
            statusBadge.className = 'status-badge offline';
        }
        activeBadge.textContent = data.activeRecordings + ' aktiv';
    } catch (err) {
        console.error('Status update failed:', err);
    }
}

function applyFilters(folders) {
    const userFilter = document.getElementById('filter-user').value.toLowerCase();
    const dateFilter = document.getElementById('filter-date').value;
    const talkFilter = document.getElementById('filter-talk').value.toLowerCase();

    return folders.filter(function(folder) {
        // Filter by talk name
        if (talkFilter && !folder.name.toLowerCase().includes(talkFilter)) return false;

        // Filter by date (exact day from created timestamp)
        if (dateFilter) {
            const folderDate = new Date(folder.created);
            const filterDate = new Date(dateFilter);
            if (folderDate.toDateString() !== filterDate.toDateString()) return false;
        }

        // Filter by user (search in file names)
        if (userFilter) {
            const hasUser = folder.files.some(function(file) {
                return file.name.toLowerCase().includes(userFilter);
            });
            if (!hasUser) return false;
        }

        return true;
    });
}

async function deleteFolder(folderName) {
    if (!confirm('Wirklich "' + folderName + '" löschen?')) return;
    try {
        const res = await fetch('/api/delete/' + encodeURIComponent(folderName), { method: 'DELETE' });
        if (res.ok) {
            loadRecordings();
        } else {
            const data = await res.json();
            alert('Fehler: ' + (data.error || 'Unbekannt'));
        }
    } catch (err) {
        alert('Fehler: ' + err.message);
    }
}

async function deleteFile(folderName, fileName) {
    if (!confirm('"' + fileName + '" löschen?')) return;
    try {
        var encodedFolder = encodeURIComponent(folderName);
        var encodedFile = encodeURIComponent(fileName);
        const res = await fetch('/api/delete/' + encodedFolder + '/' + encodedFile, { method: 'DELETE' });
        if (res.ok) {
            openModal(folderName);
        } else {
            const data = await res.json();
            alert('Fehler: ' + (data.error || 'Unbekannt'));
        }
    } catch (err) {
        alert('Fehler: ' + err.message);
    }
}

function renderRecordings(folders) {
    const filtered = applyFilters(folders);
    const list = document.getElementById('recordings-list');
    list.innerHTML = filtered.map(function(folder) {
        var safeName = escapeHtml(folder.name);
        var safeDate = escapeHtml(formatDate(folder.created));
        var fileCount = folder.fileCount;
        var safeSize = escapeHtml(formatBytes(folder.totalSize));

        var actions = '<button class="btn btn-danger btn-delete" data-folder="' + safeName + '">Löschen</button>';
        if (folder.files.length === 1) {
            actions += '<a href="' + escapeHtml(folder.files[0].url) + '" class="btn btn-primary" download>Download</a>';
        } else {
            actions += '<button class="btn btn-primary btn-view" data-folder="' + safeName + '">Dateien</button>';
        }

        var fileListHtml = '';
        if (folder.files.length <= 3) {
            fileListHtml = renderFileList(folder);
        }

        return '<div class="recording-card" data-folder="' + safeName + '">' +
            '<div class="card-header">' +
                '<div>' +
                    '<h3 class="card-title">' + safeName + '</h3>' +
                    '<div class="card-meta">' +
                        '<span class="meta-item">' + safeDate + '</span>' +
                        '<span class="meta-item">' + fileCount + ' Dateien</span>' +
                        '<span class="meta-item">' + safeSize + '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="card-actions">' + actions + '</div>' +
            '</div>' +
            fileListHtml +
        '</div>';
    }).join('');

    // Show filtered count
    var countEl = document.getElementById('filter-count');
    if (countEl) {
        if (filtered.length < folders.length) {
            countEl.textContent = filtered.length + ' von ' + folders.length + ' angezeigt';
        } else {
            countEl.textContent = folders.length + ' Aufnahmen';
        }
    }

    document.querySelectorAll('.btn-view').forEach(function(btn) {
        btn.addEventListener('click', function() {
            openModal(this.getAttribute('data-folder'));
        });
    });

    document.querySelectorAll('.btn-delete').forEach(function(btn) {
        btn.addEventListener('click', function() {
            deleteFolder(this.getAttribute('data-folder'));
        });
    });
}

function renderFileList(folder) {
    var safeFolderName = escapeHtml(folder.name);
    return '<div class="file-list">' +
        folder.files.map(function(file) {
            var safeFileName = escapeHtml(sanitizeName(file.name));
            var safeSize = escapeHtml(formatBytes(file.size));
            var safeUrl = escapeHtml(file.url);
            var safeTitle = escapeHtml(file.name);
            var encodedFileName = encodeURIComponent(file.name);
            return '<div class="file-item">' +
                '<div class="file-info">' +
                    '<svg class="file-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">' +
                        '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>' +
                    '</svg>' +
                    '<span class="file-name" title="' + safeTitle + '">' + safeFileName + '</span>' +
                    '<span class="file-size">' + safeSize + '</span>' +
                '</div>' +
                '<div class="file-actions">' +
                    '<a href="' + safeUrl + '" class="download-btn" download>Download</a>' +
                    '<button class="btn-delete-file" data-folder="' + safeFolderName + '" data-file="' + encodedFileName + '">X</button>' +
                '</div>' +
            '</div>';
        }).join('') +
    '</div>';
}

function openModal(folderName) {
    var modal = document.getElementById('modal');
    var title = document.getElementById('modal-title');
    var body = document.getElementById('modal-body');

    title.textContent = folderName;
    body.innerHTML = '<p class="loading-text">Lade...</p>';
    modal.classList.remove('hidden');

    fetch(RECORDINGS_ENDPOINT)
        .then(function(res) {
            if (!res.ok) throw new Error('Fehler');
            return res.json();
        })
        .then(function(data) {
            var folder = data.folders.find(function(f) { return f.name === folderName; });
            if (!folder) {
                body.innerHTML = '<p>Ordner nicht gefunden</p>';
                return;
            }
            body.innerHTML = renderFileList(folder);
            body.querySelectorAll('.btn-delete-file').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    deleteFile(folderName, decodeURIComponent(this.getAttribute('data-file')));
                });
            });
        })
        .catch(function() {
            body.innerHTML = '<p class="error">Fehler beim Laden</p>';
        });
}

function closeModal() {
    document.getElementById('modal').classList.add('hidden');
}

document.getElementById('modal-close').addEventListener('click', closeModal);

document.getElementById('modal').addEventListener('click', function(e) {
    if (e.target.id === 'modal') closeModal();
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeModal();
});

document.getElementById('logout-btn').addEventListener('click', function() {
    fetch('/api/logout', { method: 'POST' })
        .then(function() {
            window.location.href = '/login';
        });
});

async function loadUserInfo() {
    try {
        const res = await fetch('/api/status');
        if (res.ok) {
            const data = await res.json();
            if (data.bot && data.bot !== 'offline') {
                document.getElementById('user-display').textContent = data.bot;
            }
        }
    } catch (err) {
        // silent fail
    }
}

// Live filter
document.getElementById('filter-user').addEventListener('input', loadRecordings);
document.getElementById('filter-date').addEventListener('change', loadRecordings);
document.getElementById('filter-talk').addEventListener('input', function() {
    var val = this.value;
    clearTimeout(this._timer);
    this._timer = setTimeout(loadRecordings, 300);
});

loadRecordings();
updateStatus();
loadUserInfo();
setInterval(updateStatus, 30000);
setInterval(loadRecordings, 60000);

// === Logs ===

let logTypes = [];
let logUsers = [];

async function loadLogs() {
    const type = document.getElementById('log-filter-type').value;
    const user = document.getElementById('log-filter-user').value;
    const from = document.getElementById('log-filter-from').value;
    const to = document.getElementById('log-filter-to').value;

    var params = new URLSearchParams();
    if (type) params.set('type', type);
    if (user) params.set('user', user);
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    document.getElementById('log-loading').classList.remove('hidden');

    try {
        const res = await fetch('/api/logs?' + params.toString());
        if (!res.ok) {
            if (res.status === 401) { window.location.href = '/login'; return; }
            throw new Error('Serverfehler');
        }
        const data = await res.json();
        document.getElementById('log-loading').classList.add('hidden');

        logTypes = data.types || [];
        logUsers = data.users || [];

        // Fill type filter
        var typeSelect = document.getElementById('log-filter-type');
        var currentType = typeSelect.value;
        typeSelect.innerHTML = '<option value="">Alle</option>' +
            logTypes.map(function(t) {
                return '<option value="' + escapeHtml(t) + '"' + (t === currentType ? ' selected' : '') + '>' + escapeHtml(t) + '</option>';
            }).join('');

        renderLogs(data.logs);
    } catch (err) {
        document.getElementById('log-loading').classList.add('hidden');
        document.getElementById('logs-list').innerHTML = '<p class="error">Fehler: ' + escapeHtml(err.message) + '</p>';
    }
}

function renderLogs(logs) {
    var list = document.getElementById('logs-list');
    if (logs.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>Keine Logs gefunden</p></div>';
        document.getElementById('log-count').textContent = '0 Einträge';
        return;
    }

    list.innerHTML = logs.map(function(entry) {
        var typeClass = 'log-type ' + (entry.type || '');
        var safeTime = escapeHtml(formatDateTime(entry.timestamp));
        var safeType = escapeHtml(entry.type || '');
        var safeUser = escapeHtml(entry.username || '');
        var safeMsg = escapeHtml(entry.message || '');

        return '<div class="log-entry">' +
            '<span class="log-time">' + safeTime + '</span>' +
            '<span class="' + typeClass + '">' + safeType + '</span>' +
            '<span class="log-user">' + safeUser + '</span>' +
            '<span class="log-msg" title="' + safeMsg + '">' + safeMsg + '</span>' +
        '</div>';
    }).join('');

    document.getElementById('log-count').textContent = logs.length + ' Einträge';
}

// Tab switching
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        this.classList.add('active');
        var tab = this.getAttribute('data-tab');
        document.querySelectorAll('[id^="tab-"]').forEach(function(el) { el.classList.add('hidden'); });
        document.getElementById('tab-' + tab).classList.remove('hidden');
        if (tab === 'logs') loadLogs();
    });
});

// Log filter events
document.getElementById('log-filter-type').addEventListener('change', loadLogs);
document.getElementById('log-filter-user').addEventListener('input', function() {
    clearTimeout(this._timer);
    this._timer = setTimeout(loadLogs, 300);
});
document.getElementById('log-filter-from').addEventListener('change', loadLogs);
document.getElementById('log-filter-to').addEventListener('change', loadLogs);