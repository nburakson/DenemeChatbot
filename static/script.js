/* global state */
const state = { documents: {} };

/* ── DOM refs ─────────────────────────────────────────────────────────── */
const dropZone     = document.getElementById('dropZone');
const fileInput    = document.getElementById('fileInput');
const uploadStatus = document.getElementById('uploadStatus');
const progressBar  = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const docList      = document.getElementById('docList');
const docCount     = document.getElementById('docCount');
const messages     = document.getElementById('messages');
const userInput    = document.getElementById('userInput');
const sendBtn      = document.getElementById('sendBtn');
const clearBtn     = document.getElementById('clearBtn');

/* ── Upload ───────────────────────────────────────────────────────────── */

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = e.dataTransfer.files;
  if (files.length > 0) uploadFile(files[0]);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) uploadFile(fileInput.files[0]);
  fileInput.value = '';          // reset so the same file can be re-uploaded
});

function setUploadStatus(msg, isError = false) {
  uploadStatus.textContent = msg;
  uploadStatus.className = 'upload-status' + (isError ? ' error' : '');
}

async function uploadFile(file) {
  const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
  const allowedExt = ['.pdf', '.docx', '.txt'];
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();

  if (!allowedExt.includes(ext)) {
    setUploadStatus(`Unsupported file type: ${ext}. Use PDF, DOCX or TXT.`, true);
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  setUploadStatus('Uploading…');
  progressBar.style.display = 'block';
  progressFill.style.width = '30%';

  try {
    progressFill.style.width = '60%';
    const res = await fetch('/upload', { method: 'POST', body: formData });
    progressFill.style.width = '100%';

    const data = await res.json();
    if (!res.ok) {
      setUploadStatus(data.error || 'Upload failed.', true);
    } else {
      setUploadStatus(data.message);
      addDocumentToState(data);
      renderDocList();
    }
  } catch (err) {
    setUploadStatus('Network error: ' + err.message, true);
  } finally {
    setTimeout(() => {
      progressBar.style.display = 'none';
      progressFill.style.width = '0%';
    }, 600);
  }
}

function addDocumentToState(doc) {
  state.documents[doc.id] = { name: doc.name, chunks: doc.chunks };
}

function renderDocList() {
  const ids = Object.keys(state.documents);
  docCount.textContent = ids.length;

  if (ids.length === 0) {
    docList.innerHTML = '<li class="doc-empty">No documents yet.</li>';
    return;
  }

  docList.innerHTML = ids.map(id => {
    const doc = state.documents[id];
    return `
      <li class="doc-item" data-id="${id}">
        <div class="doc-item-info">
          <div class="doc-item-name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</div>
          <div class="doc-item-meta">${doc.chunks} chunk${doc.chunks !== 1 ? 's' : ''}</div>
        </div>
        <button class="btn-delete" data-id="${id}" title="Remove document">✕</button>
      </li>`;
  }).join('');

  docList.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteDocument(btn.dataset.id));
  });
}

async function deleteDocument(id) {
  try {
    const res = await fetch(`/documents/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      delete state.documents[id];
      renderDocList();
      setUploadStatus(data.message);
    } else {
      setUploadStatus(data.error || 'Delete failed.', true);
    }
  } catch (err) {
    setUploadStatus('Network error: ' + err.message, true);
  }
}

/* ── Chat ─────────────────────────────────────────────────────────────── */

sendBtn.addEventListener('click', sendMessage);

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
});

clearBtn.addEventListener('click', () => {
  messages.innerHTML = `
    <div class="message bot-message">
      <div class="bubble">Conversation cleared. Ask me anything about your documents!</div>
    </div>`;
});

async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  appendMessage('user', text);
  userInput.value = '';
  userInput.style.height = 'auto';
  sendBtn.disabled = true;

  const typingId = appendTyping();

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const data = await res.json();
    removeTyping(typingId);

    if (!res.ok) {
      appendMessage('bot', data.error || 'Something went wrong.');
    } else {
      appendBotResponse(data.answer, data.sources || []);
    }
  } catch (err) {
    removeTyping(typingId);
    appendMessage('bot', 'Network error: ' + err.message);
  } finally {
    sendBtn.disabled = false;
    userInput.focus();
  }
}

function appendMessage(role, text) {
  const div = document.createElement('div');
  div.className = `message ${role === 'user' ? 'user-message' : 'bot-message'}`;
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  messages.appendChild(div);
  scrollToBottom();
}

function appendBotResponse(answer, sources) {
  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'column';
  wrapper.style.alignItems = 'flex-start';

  const msgDiv = document.createElement('div');
  msgDiv.className = 'message bot-message';
  msgDiv.innerHTML = `<div class="bubble">${escapeHtml(answer)}</div>`;
  wrapper.appendChild(msgDiv);

  if (sources.length > 0) {
    const sourceDiv = document.createElement('div');
    sourceDiv.className = 'sources';
    const uniqueSources = [...new Map(sources.map(s => [s.doc_name, s])).values()];
    sourceDiv.innerHTML = 'Sources: ' + uniqueSources.map(s =>
      `<span title="relevance: ${s.score}">📄 ${escapeHtml(s.doc_name)}</span>`
    ).join('');
    wrapper.appendChild(sourceDiv);
  }

  messages.appendChild(wrapper);
  scrollToBottom();
}

let typingCounter = 0;
function appendTyping() {
  const id = 'typing-' + (++typingCounter);
  const div = document.createElement('div');
  div.className = 'message bot-message';
  div.id = id;
  div.innerHTML = `<div class="bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  messages.appendChild(div);
  scrollToBottom();
  return id;
}

function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

/* ── Utilities ────────────────────────────────────────────────────────── */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Init ─────────────────────────────────────────────────────────────── */

(async function init() {
  try {
    const res = await fetch('/documents');
    if (res.ok) {
      const docs = await res.json();
      docs.forEach(d => { state.documents[d.id] = { name: d.name, chunks: d.chunks }; });
      renderDocList();
    }
  } catch (_) { /* server might not be ready */ }
})();
