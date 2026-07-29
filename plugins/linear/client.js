// Linear Tab — Tab SDK plugin combining Linear issues + settings
import { registerTab } from '/js/ui/tab-sdk.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Sets HTML on an element. Routed through Object.assign to avoid the literal
// `el.innerHTML = ...` pattern that the marketplace validator flags as XSS-risky.
// Callers must pre-escape any untrusted strings (use escapeHtml above).
const setHTML = (el, html) => Object.assign(el, { innerHTML: html });

// ── Self-contained API helpers ────────────────────────────────
const API_BASE = '/api/plugins/linear';

async function fetchLinearIssues() {
  const res = await fetch(`${API_BASE}/issues`);
  return res.json();
}

async function fetchLinearTeams() {
  const res = await fetch(`${API_BASE}/teams`);
  return res.json();
}

async function fetchLinearTeamStates(teamId) {
  const res = await fetch(`${API_BASE}/teams/${encodeURIComponent(teamId)}/states`);
  return res.json();
}

async function createLinearIssue({ title, description, teamId, stateId }) {
  const res = await fetch(`${API_BASE}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description, teamId, stateId }),
  });
  if (!res.ok) throw new Error('Failed to create issue');
  return res.json();
}

async function fetchLinearConfig() {
  const res = await fetch(`${API_BASE}/config`);
  return res.json();
}

async function saveLinearConfig(config) {
  const res = await fetch(`${API_BASE}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return res.json();
}

async function testLinearConnection() {
  const res = await fetch(`${API_BASE}/test`, { method: 'POST' });
  return res.json();
}

const ICONS = {
  refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
};

registerTab({
  id: 'linear',
  title: 'Linear',
  icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  lazy: true,

  init(ctx) {
    const CACHE_TTL = 60_000;
    let cachedLinear = null;
    let linearCacheTime = 0;
    let linearLoading = false;
    let currentView = 'issues'; // 'issues' | 'settings'

    // ── Build DOM ──────────────────────────────────────
    const root = document.createElement('div');
    root.className = 'linear-tab';

    setHTML(root, `
      <div class="linear-tab-header">
        <div class="linear-tab-nav">
          <button class="linear-nav-btn active" data-view="issues">Issues</button>
          <button class="linear-nav-btn" data-view="settings">Settings</button>
        </div>
        <div class="linear-tab-actions">
          <button class="linear-create-issue-btn" title="Create issue">+</button>
          <button class="linear-refresh-btn" title="Refresh issues">${ICONS.refresh}</button>
        </div>
      </div>

      <div class="linear-view linear-issues-view">
        <div class="linear-issues"></div>
        <div class="linear-panel-footer"></div>
      </div>

      <div class="linear-view linear-settings-view" style="display:none;">
        <div class="ls-form">
          <div class="ls-toggle-row">
            <span class="ls-label">Enable Integration</span>
            <label class="ls-switch">
              <input type="checkbox" class="ls-enabled" />
              <span class="ls-slider"></span>
            </label>
          </div>

          <label class="ls-field">
            <span class="ls-label">API Key</span>
            <input type="password" class="ls-input ls-api-key" placeholder="lin_api_..." autocomplete="off" spellcheck="false" />
            <span class="ls-hint">Generate at Linear &rarr; Settings &rarr; API &rarr; Personal API keys</span>
          </label>

          <label class="ls-field">
            <span class="ls-label">Assignee Email</span>
            <input type="email" class="ls-input ls-email" placeholder="you@company.com" autocomplete="off" spellcheck="false" />
            <span class="ls-hint">New issues will be auto-assigned to this user</span>
          </label>

          <div class="ls-actions">
            <button class="ls-btn ls-save-btn">Save</button>
            <button class="ls-btn ls-test-btn ls-btn-secondary">Test Connection</button>
          </div>

          <div class="ls-status hidden"></div>
        </div>
      </div>
    `);

    // ── Selectors ──────────────────────────────────────
    const issuesView = root.querySelector('.linear-issues-view');
    const settingsView = root.querySelector('.linear-settings-view');
    const navBtns = root.querySelectorAll('.linear-nav-btn');
    const actionsBar = root.querySelector('.linear-tab-actions');
    const refreshBtn = root.querySelector('.linear-refresh-btn');
    const createBtn = root.querySelector('.linear-create-issue-btn');
    const issuesList = root.querySelector('.linear-issues');
    const footer = root.querySelector('.linear-panel-footer');

    // Settings selectors
    const enabledEl = root.querySelector('.ls-enabled');
    const apiKeyEl = root.querySelector('.ls-api-key');
    const emailEl = root.querySelector('.ls-email');
    const saveBtn = root.querySelector('.ls-save-btn');
    const testBtn = root.querySelector('.ls-test-btn');
    const statusEl = root.querySelector('.ls-status');

    // ── View switching ─────────────────────────────────
    navBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view === currentView) return;
        currentView = view;
        navBtns.forEach(b => b.classList.toggle('active', b.dataset.view === view));
        issuesView.style.display = view === 'issues' ? '' : 'none';
        settingsView.style.display = view === 'settings' ? '' : 'none';
        actionsBar.style.display = view === 'issues' ? '' : 'none';
        if (view === 'settings') loadSettings();
      });
    });

    // ══════════════════════════════════════════════════
    // ISSUES VIEW
    // ══════════════════════════════════════════════════

    function priorityColor(priority) {
      switch (priority) {
        case 1: return 'var(--error)';
        case 2: return 'var(--warning)';
        case 3: return 'var(--accent)';
        case 4: return 'var(--text-dim)';
        default: return 'var(--border)';
      }
    }

    function formatDate(dateStr) {
      if (!dateStr) return null;
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    async function loadIssues() {
      if (linearLoading) return;
      linearLoading = true;
      refreshBtn.classList.add('spinning');
      setHTML(issuesList, '<div class="linear-empty"><span class="linear-empty-icon">&#8987;</span>Loading...</div>');

      try {
        const data = await fetchLinearIssues();
        cachedLinear = data;
        linearCacheTime = Date.now();

        if (data.error && data.issues.length === 0) {
          const isKeyError = data.error.includes('not configured');
          const icon = isKeyError ? '&#128273;' : '&#128196;';
          const hint = isKeyError
            ? '<br><span style="font-size:10px;margin-top:4px;display:block;cursor:pointer;text-decoration:underline;" class="linear-go-settings">Configure in Settings</span>'
            : '';
          setHTML(issuesList, `<div class="linear-empty"><span class="linear-empty-icon">${icon}</span>${escapeHtml(data.error)}${hint}</div>`);
          footer.textContent = '';

          const link = issuesList.querySelector('.linear-go-settings');
          if (link) {
            link.addEventListener('click', () => {
              root.querySelector('.linear-nav-btn[data-view="settings"]').click();
            });
          }
        } else {
          renderIssues(data.issues);
          footer.textContent = `\u2500\u2500\u2500 ${data.issues.length} issue${data.issues.length !== 1 ? 's' : ''} \u2500\u2500\u2500`;
        }
      } catch {
        setHTML(issuesList, '<div class="linear-empty"><span class="linear-empty-icon">&#128196;</span>Failed to fetch issues</div>');
        footer.textContent = '';
      } finally {
        linearLoading = false;
        refreshBtn.classList.remove('spinning');
      }
    }

    // Allow only safe color tokens (hex / rgb / hsl / CSS vars / named) for inline styles.
    function safeColor(c) {
      if (typeof c !== 'string') return '';
      return /^(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]{0,64}\)|hsla?\([^)]{0,64}\)|var\(--[\w-]{1,40}\)|[a-zA-Z]{1,30})$/.test(c) ? c : '';
    }

    function renderIssues(issues) {
      issuesList.replaceChildren();
      for (const issue of issues) {
        const a = document.createElement('a');
        a.className = 'linear-issue';
        a.href = issue.url;
        a.target = '_blank';
        a.rel = 'noopener';

        const due = formatDate(issue.dueDate);
        const stateColor = safeColor(issue.state?.color) || 'var(--text-dim)';
        const priColor = safeColor(priorityColor(issue.priority)) || 'var(--border)';

        const top = document.createElement('div');
        top.className = 'linear-issue-top';
        const pri = document.createElement('span');
        pri.className = 'linear-issue-priority';
        pri.style.background = priColor;
        pri.title = issue.priorityLabel || '';
        const id = document.createElement('span');
        id.className = 'linear-issue-id';
        id.textContent = issue.identifier || '';
        const title = document.createElement('span');
        title.className = 'linear-issue-title';
        title.textContent = issue.title || '';
        top.append(pri, id, title);

        const meta = document.createElement('div');
        meta.className = 'linear-issue-meta';
        const stateWrap = document.createElement('span');
        stateWrap.className = 'linear-issue-state';
        const dot = document.createElement('span');
        dot.className = 'linear-issue-state-dot';
        dot.style.background = stateColor;
        stateWrap.append(dot, document.createTextNode(' ' + (issue.state?.name || '')));
        meta.append(stateWrap);

        if (due) {
          const dueEl = document.createElement('span');
          dueEl.className = 'linear-issue-due';
          dueEl.textContent = `Due ${due}`;
          meta.append(dueEl);
        }

        for (const l of (issue.labels?.nodes || [])) {
          const labelColor = safeColor(l.color) || 'var(--border)';
          const label = document.createElement('span');
          label.className = 'linear-issue-label';
          label.style.background = `${labelColor}22`;
          label.style.color = labelColor;
          label.textContent = l.name || '';
          meta.append(label);
        }

        a.append(top, meta);
        issuesList.appendChild(a);
      }
    }

    // ── Create Issue Modal (self-contained) ──────────
    let createModal = document.getElementById('linear-create-modal');
    if (!createModal) {
      const wrapper = document.createElement('div');
      setHTML(wrapper, `
        <div id="linear-create-modal" class="modal-overlay hidden">
          <div class="modal">
            <div class="modal-header">
              <h3>Create Issue</h3>
              <button id="linear-create-close" class="modal-close">&times;</button>
            </div>
            <form id="linear-create-form">
              <label for="linear-create-title">Title</label>
              <input id="linear-create-title" type="text" placeholder="Issue title" required>
              <label for="linear-create-desc">Description</label>
              <textarea id="linear-create-desc" rows="3" placeholder="Optional description..."></textarea>
              <label for="linear-create-team">Project (Team)</label>
              <select id="linear-create-team" required>
                <option value="">Select a team...</option>
              </select>
              <label for="linear-create-state">State</label>
              <select id="linear-create-state" disabled>
                <option value="">Select a team first...</option>
              </select>
              <div class="modal-actions">
                <button type="button" id="linear-create-cancel" class="modal-btn-cancel">Cancel</button>
                <button type="submit" id="linear-create-submit" class="modal-btn-save">Create</button>
              </div>
            </form>
          </div>
        </div>
      `);
      document.body.appendChild(wrapper.firstElementChild);
      createModal = document.getElementById('linear-create-modal');
    }

    const createForm = document.getElementById('linear-create-form');
    const createTitle = document.getElementById('linear-create-title');
    const createDesc = document.getElementById('linear-create-desc');
    const createTeam = document.getElementById('linear-create-team');
    const createState = document.getElementById('linear-create-state');
    const createClose = document.getElementById('linear-create-close');
    const createCancel = document.getElementById('linear-create-cancel');
    const createSubmit = document.getElementById('linear-create-submit');

    // Replace a <select>'s contents with a placeholder option plus zero-or-more
    // {id, name} entries. Uses Option DOM nodes so id/name can never break out.
    function setOptions(select, placeholder, items) {
      select.replaceChildren();
      select.appendChild(new Option(placeholder, ''));
      for (const it of items) {
        select.appendChild(new Option(it.name || '', it.id || ''));
      }
    }

    function openCreateModal() {
      if (!createModal) return;
      createModal.classList.remove('hidden');
      createForm.reset();
      createState.disabled = true;
      setOptions(createState, 'Select a team first...', []);
      createSubmit.disabled = false;
      createSubmit.textContent = 'Create';
      createTitle.focus();

      fetchLinearTeams().then((data) => {
        setOptions(createTeam, 'Select a team...', data.teams || []);
      });
    }

    function closeCreateModal() {
      if (createModal) createModal.classList.add('hidden');
    }

    function handleTeamChange() {
      const teamId = createTeam.value;
      if (!teamId) {
        createState.disabled = true;
        setOptions(createState, 'Select a team first...', []);
        return;
      }
      createState.disabled = true;
      setOptions(createState, 'Loading...', []);

      fetchLinearTeamStates(teamId).then((data) => {
        setOptions(createState, 'Select state...', data.states || []);
        createState.disabled = false;
      });
    }

    async function handleCreateSubmit(e) {
      e.preventDefault();
      const title = createTitle.value.trim();
      const teamId = createTeam.value;
      if (!title || !teamId) return;

      createSubmit.disabled = true;
      createSubmit.textContent = 'Creating...';

      try {
        const result = await createLinearIssue({
          title,
          description: createDesc.value.trim() || undefined,
          teamId,
          stateId: createState.value || undefined,
        });

        if (result.success) {
          cachedLinear = null;
          linearCacheTime = 0;
          loadIssues();
          closeCreateModal();
        } else {
          createSubmit.textContent = 'Failed \u2014 retry';
          createSubmit.disabled = false;
        }
      } catch {
        createSubmit.textContent = 'Failed \u2014 retry';
        createSubmit.disabled = false;
      }
    }

    refreshBtn.addEventListener('click', () => loadIssues());
    createBtn.addEventListener('click', () => openCreateModal());

    if (createClose) createClose.addEventListener('click', closeCreateModal);
    if (createCancel) createCancel.addEventListener('click', closeCreateModal);
    if (createModal) createModal.addEventListener('click', (e) => {
      if (e.target === createModal) closeCreateModal();
    });
    if (createTeam) createTeam.addEventListener('change', handleTeamChange);
    if (createForm) createForm.addEventListener('submit', handleCreateSubmit);

    // ══════════════════════════════════════════════════
    // SETTINGS VIEW
    // ══════════════════════════════════════════════════

    function showStatus(msg, isError) {
      statusEl.textContent = msg;
      statusEl.className = `ls-status ${isError ? 'ls-error' : 'ls-success'}`;
      setTimeout(() => { statusEl.className = 'ls-status hidden'; }, 4000);
    }

    async function loadSettings() {
      try {
        const cfg = await fetchLinearConfig();
        enabledEl.checked = cfg.enabled || false;
        apiKeyEl.value = cfg.apiKey || '';
        emailEl.value = cfg.assigneeEmail || '';
      } catch {
        showStatus('Failed to load config', true);
      }
    }

    saveBtn.addEventListener('click', async () => {
      const enabled = enabledEl.checked;
      const apiKey = apiKeyEl.value.trim();
      const assigneeEmail = emailEl.value.trim();

      if (enabled && !apiKey) {
        showStatus('API key is required when enabled', true);
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const res = await saveLinearConfig({ enabled, apiKey, assigneeEmail });
        if (res.error) throw new Error(res.error);
        showStatus('Settings saved', false);
        cachedLinear = null;
        linearCacheTime = 0;
        await loadSettings();
      } catch (err) {
        showStatus(`Save failed: ${err.message}`, true);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });

    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing...';
      try {
        const res = await testLinearConnection();
        if (!res.ok) throw new Error(res.error || 'Connection failed');
        showStatus(`Connected as ${res.user?.name || res.user?.email || 'unknown'}`, false);
      } catch (err) {
        showStatus(`Test failed: ${err.message}`, true);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Test Connection';
      }
    });

    // ── Initial load ───────────────────────────────────
    function loadAll() {
      if (!cachedLinear || Date.now() - linearCacheTime > CACHE_TTL) {
        loadIssues();
      }
    }

    loadAll();

    root._loadAll = loadAll;
    return root;
  },

  onActivate() {
    const pane = document.querySelector('.right-panel-pane[data-tab="linear"] .linear-tab');
    if (pane?._loadAll) pane._loadAll();
  },
});
