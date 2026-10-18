// KeyShield Frontend Console Logic

let currentTenantId = 1;
let currentAuditPage = 1;
const auditPageLimit = 10;
let usageChartInstance = null;
let selectedKeyIdForAction = null;

// Initialize on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  initUsageChart();
  loadTenants().then(() => {
    refreshAll();
  });
});

function setupEventListeners() {
  // Tenant selection change
  document.getElementById('tenantSelect').addEventListener('change', (e) => {
    currentTenantId = parseInt(e.target.value, 10);
    currentAuditPage = 1;
    refreshAll();
  });

  // Refresh button
  document.getElementById('refreshBtn').addEventListener('click', () => {
    refreshAll();
  });

  // Issue modal triggers
  document.getElementById('openIssueModalBtn').addEventListener('click', () => {
    openModal('issueModal');
  });

  document.getElementById('confirmIssueBtn').addEventListener('click', handleIssueKey);

  // Rotate & Revoke confirmation triggers
  document.getElementById('confirmRotateBtn').addEventListener('click', handleConfirmRotate);
  document.getElementById('confirmRevokeBtn').addEventListener('click', handleConfirmRevoke);

  // Close modals
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close');
      closeModal(modalId);
    });
  });

  // Copy key button
  document.getElementById('copyKeyBtn').addEventListener('click', () => {
    const key = document.getElementById('generatedKeyText').innerText;
    navigator.clipboard.writeText(key).then(() => {
      const btn = document.getElementById('copyKeyBtn');
      btn.innerText = 'Copied!';
      setTimeout(() => (btn.innerText = 'Copy'), 2000);
    });
  });

  // Pagination buttons
  document.getElementById('prevPageBtn').addEventListener('click', () => {
    if (currentAuditPage > 1) {
      currentAuditPage--;
      loadAuditLogs();
    }
  });

  document.getElementById('nextPageBtn').addEventListener('click', () => {
    currentAuditPage++;
    loadAuditLogs();
  });

  // Sandbox triggers
  document.getElementById('sendSingleReqBtn').addEventListener('click', () => sendSandboxRequests(1));
  document.getElementById('sendBurstReqBtn').addEventListener('click', () => sendSandboxRequests(6));
  document.getElementById('clearOutputBtn').addEventListener('click', () => {
    document.getElementById('sandboxOutput').innerText = 'Output cleared.';
  });
}

async function refreshAll() {
  await Promise.all([
    loadKeys(),
    loadAuditLogs(),
    loadUsageStats(),
  ]);
}

// -------------------------------------------------------------
// Tenant Operations
// -------------------------------------------------------------
async function loadTenants() {
  try {
    const res = await fetch('/api/tenants');
    if (!res.ok) throw new Error('Failed to load tenants');
    const tenants = await res.json();

    const select = document.getElementById('tenantSelect');
    select.innerHTML = '';

    tenants.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.name} (ID: ${t.id})`;
      if (t.id === currentTenantId) opt.selected = true;
      select.appendChild(opt);
    });

    if (tenants.length > 0) {
      currentTenantId = parseInt(select.value, 10);
    }
  } catch (err) {
    console.error('Error loading tenants:', err);
  }
}

// -------------------------------------------------------------
// Keys Management
// -------------------------------------------------------------
async function loadKeys() {
  const tbody = document.getElementById('keysTableBody');
  try {
    const res = await fetch(`/api/tenants/${currentTenantId}/keys`);
    if (!res.ok) throw new Error('Failed to fetch keys');
    const keys = await res.json();

    document.getElementById('statActiveKeys').innerText = keys.filter(k => k.isActive).length;

    if (keys.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No API keys found for this tenant. Issue one above!</td></tr>`;
      return;
    }

    tbody.innerHTML = keys.map((key) => {
      let statusBadge = '<span class="badge badge-success">Active</span>';
      let graceInfo = '<span class="text-muted">None</span>';

      if (!key.rawIsActive) {
        statusBadge = '<span class="badge badge-danger">Revoked</span>';
      } else if (key.expiresAt) {
        const expDate = new Date(key.expiresAt);
        const isExpired = expDate <= new Date();
        if (isExpired) {
          statusBadge = '<span class="badge badge-danger">Expired</span>';
          graceInfo = `<span class="text-danger">Expired at ${expDate.toLocaleTimeString()}</span>`;
        } else {
          statusBadge = '<span class="badge badge-warning">Rotating</span>';
          graceInfo = `<span class="text-warning">Expiring at ${expDate.toLocaleTimeString()}</span>`;
        }
      }

      const actionsDisabled = !key.rawIsActive;

      return `
        <tr>
          <td><strong>#${key.id}</strong></td>
          <td><code>${escapeHtml(key.maskedKey)}</code></td>
          <td>${key.rateLimitPerMinute} req/min</td>
          <td>${statusBadge}</td>
          <td>${graceInfo}</td>
          <td>${new Date(key.createdAt).toLocaleString()}</td>
          <td class="text-right">
            <button class="btn btn-sm btn-secondary" onclick="openRotateModal(${key.id}, '${escapeHtml(key.maskedKey)}')" ${actionsDisabled ? 'disabled' : ''}>Rotate</button>
            <button class="btn btn-sm btn-danger" onclick="openRevokeModal(${key.id}, '${escapeHtml(key.maskedKey)}')" ${actionsDisabled ? 'disabled' : ''}>Revoke</button>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Error: ${err.message}</td></tr>`;
  }
}

async function handleIssueKey() {
  const rateLimitInput = document.getElementById('newKeyRateLimit');
  const rateLimit = parseInt(rateLimitInput.value, 10) || 100;

  try {
    const res = await fetch(`/api/tenants/${currentTenantId}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rateLimitPerMinute: rateLimit }),
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.message || 'Failed to issue key');
    }

    const data = await res.json();
    closeModal('issueModal');

    // Show result modal with one-time plaintext key
    document.getElementById('generatedKeyText').innerText = data.apiKey;
    // Pre-fill into sandbox
    document.getElementById('sandboxKey').value = data.apiKey;
    openModal('keyResultModal');

    refreshAll();
  } catch (err) {
    alert('Error issuing key: ' + err.message);
  }
}

// Rotate modal actions
window.openRotateModal = function(keyId, maskedKey) {
  selectedKeyIdForAction = keyId;
  document.getElementById('rotateKeyMask').innerText = maskedKey;
  openModal('rotateModal');
};

async function handleConfirmRotate() {
  if (!selectedKeyIdForAction) return;

  try {
    const res = await fetch(`/api/keys/${selectedKeyIdForAction}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gracePeriodSeconds: 60 }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Key rotation failed');
    }

    const data = await res.json();
    closeModal('rotateModal');

    document.getElementById('generatedKeyText').innerText = data.newApiKey;
    document.getElementById('sandboxKey').value = data.newApiKey;
    openModal('keyResultModal');

    refreshAll();
  } catch (err) {
    alert('Error rotating key: ' + err.message);
  }
}

// Revoke modal actions
window.openRevokeModal = function(keyId, maskedKey) {
  selectedKeyIdForAction = keyId;
  document.getElementById('revokeKeyMask').innerText = maskedKey;
  openModal('revokeModal');
};

async function handleConfirmRevoke() {
  if (!selectedKeyIdForAction) return;

  try {
    const res = await fetch(`/api/keys/${selectedKeyIdForAction}`, {
      method: 'DELETE',
    });

    if (res.status !== 204 && !res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Revocation failed');
    }

    closeModal('revokeModal');
    refreshAll();
  } catch (err) {
    alert('Error revoking key: ' + err.message);
  }
}

// -------------------------------------------------------------
// Audit Logs & Usage Stats
// -------------------------------------------------------------
async function loadAuditLogs() {
  const tbody = document.getElementById('auditTableBody');
  try {
    const res = await fetch(`/api/tenants/${currentTenantId}/audit-logs?page=${currentAuditPage}&limit=${auditPageLimit}`);
    if (!res.ok) throw new Error('Failed to fetch audit logs');
    const data = await res.json();

    document.getElementById('pageInfo').innerText = `Page ${data.page} of ${data.totalPages || 1} (${data.total} total logs)`;
    document.getElementById('prevPageBtn').disabled = data.page <= 1;
    document.getElementById('nextPageBtn').disabled = data.page >= data.totalPages;

    if (data.logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No audit logs recorded yet. Send requests via the sandbox to populate.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.logs.map((log) => {
      const statusBadge = log.statusCode === 200
        ? '<span class="badge badge-success">200 OK</span>'
        : log.statusCode === 429
        ? '<span class="badge badge-warning">429 Too Many Requests</span>'
        : `<span class="badge badge-danger">${log.statusCode}</span>`;

      return `
        <tr>
          <td>#${log.id}</td>
          <td><code>${escapeHtml(log.maskedKey)}</code></td>
          <td><strong>${escapeHtml(log.endpoint)}</strong></td>
          <td>${statusBadge}</td>
          <td>${new Date(log.timestamp).toLocaleString()}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Error: ${err.message}</td></tr>`;
  }
}

async function loadUsageStats() {
  try {
    const res = await fetch(`/api/tenants/${currentTenantId}/stats?hours=1`);
    if (!res.ok) return;
    const { stats } = await res.json();

    let total200 = 0;
    let total429 = 0;

    stats.forEach((s) => {
      const count = parseInt(s.count, 10);
      if (s.status_code === 200) total200 += count;
      if (s.status_code === 429) total429 += count;
    });

    document.getElementById('statTotalRequests').innerText = total200 + total429;
    document.getElementById('statRateLimited').innerText = total429;

    updateUsageChart(stats);
  } catch (err) {
    console.error('Error fetching usage stats:', err);
  }
}

function initUsageChart() {
  const ctx = document.getElementById('usageChart').getContext('2d');
  usageChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: '200 OK',
          data: [],
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: 0.3,
          fill: true,
        },
        {
          label: '429 Rate Limited',
          data: [],
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          tension: 0.3,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8' },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8', stepSize: 1 },
        },
      },
      plugins: {
        legend: {
          labels: { color: '#f8fafc' },
        },
      },
    },
  });
}

function updateUsageChart(stats) {
  if (!usageChartInstance) return;

  // Group by bucket timestamp
  const timeMap = {};
  stats.forEach((s) => {
    const timeLabel = new Date(s.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (!timeMap[timeLabel]) {
      timeMap[timeLabel] = { ok: 0, limited: 0 };
    }
    const count = parseInt(s.count, 10);
    if (s.status_code === 200) timeMap[timeLabel].ok += count;
    if (s.status_code === 429) timeMap[timeLabel].limited += count;
  });

  const labels = Object.keys(timeMap);
  const data200 = labels.map((l) => timeMap[l].ok);
  const data429 = labels.map((l) => timeMap[l].limited);

  usageChartInstance.data.labels = labels.length > 0 ? labels : ['Past Hour'];
  usageChartInstance.data.datasets[0].data = labels.length > 0 ? data200 : [0];
  usageChartInstance.data.datasets[1].data = labels.length > 0 ? data429 : [0];
  usageChartInstance.update();
}

// -------------------------------------------------------------
// Interactive Sandbox
// -------------------------------------------------------------
async function sendSandboxRequests(count) {
  const key = document.getElementById('sandboxKey').value.trim();
  const output = document.getElementById('sandboxOutput');

  if (!key) {
    alert('Please enter or issue an API key in the sandbox input first.');
    return;
  }

  output.innerText = `[${new Date().toLocaleTimeString()}] Sending ${count} request(s) to GET /api/protected...\n`;

  for (let i = 1; i <= count; i++) {
    try {
      const res = await fetch('/api/protected', {
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });

      const retryAfter = res.headers.get('Retry-After');
      const limit = res.headers.get('X-RateLimit-Limit');
      const remaining = res.headers.get('X-RateLimit-Remaining');
      const data = await res.json().catch(() => ({}));

      const headerInfo = `[Limit: ${limit || 'N/A'}, Remaining: ${remaining || 'N/A'}${retryAfter ? `, Retry-After: ${retryAfter}s` : ''}]`;
      const statusText = res.status === 200 ? '✅ 200 OK' : res.status === 429 ? '⚠️ 429 TOO MANY REQUESTS' : `❌ ${res.status}`;

      output.innerText += `Req #${i}: ${statusText} ${headerInfo}\n  Body: ${JSON.stringify(data)}\n`;
    } catch (err) {
      output.innerText += `Req #${i}: ❌ Network Error: ${err.message}\n`;
    }
  }

  output.scrollTop = output.scrollHeight;

  // Refresh tables and chart
  await refreshAll();
}

// -------------------------------------------------------------
// Modal Utilities
// -------------------------------------------------------------
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
