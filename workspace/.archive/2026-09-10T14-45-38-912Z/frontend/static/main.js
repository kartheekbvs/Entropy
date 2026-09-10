/**
 * ModelForge — Main JavaScript
 * GSAP ScrollTrigger animations + demo console + page init
 */

'use strict';

// ── Wait for DOM ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  initScrollProgress();
  initScrollAnimations();
  initCounters();
  initNav();
  initUploadPage();
  initDashboardPage();
  initAPIKeysPage();
  initDemoConsole();
  initFadeInObserver();
});

// ── Particles ─────────────────────────────────────────────────────────────────
function initParticles() {
  const container = document.getElementById('particles');
  if (!container) return;

  const count = window.matchMedia('(max-width: 768px)').matches ? 8 : 16;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random() * 4 + 2;
    p.style.cssText = `
      left: ${Math.random() * 100}%;
      width: ${size}px;
      height: ${size}px;
      --duration: ${Math.random() * 12 + 8}s;
      --delay: ${Math.random() * 10}s;
      animation-delay: ${Math.random() * 10}s;
      background: ${Math.random() > 0.5 ? 'var(--accent)' : 'var(--primary)'};
    `;
    container.appendChild(p);
  }
}

// ── Scroll Progress Bar ───────────────────────────────────────────────────────
function initScrollProgress() {
  const bar = document.querySelector('.scroll-progress');
  if (!bar) return;

  window.addEventListener('scroll', () => {
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    bar.style.width = pct + '%';
  }, { passive: true });
}

// ── Nav scroll effect ─────────────────────────────────────────────────────────
function initNav() {
  const nav = document.querySelector('.mf-nav');
  if (!nav) return;

  window.addEventListener('scroll', () => {
    if (window.scrollY > 60) {
      nav.style.background = 'rgba(7,19,13,0.95)';
      nav.style.boxShadow = '0 1px 30px rgba(0,0,0,0.4)';
    } else {
      nav.style.background = 'rgba(7,19,13,0.72)';
      nav.style.boxShadow = 'none';
    }
  }, { passive: true });
}

// ── GSAP ScrollTrigger Animations ──────────────────────────────────────────────
function initScrollAnimations() {
  if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') {
    // Fallback — just show elements
    document.querySelectorAll('.reveal-item, .reveal-card').forEach(el => {
      el.style.opacity = '1';
      el.style.transform = 'none';
      el.style.transition = 'opacity 0.6s, transform 0.6s';
    });
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  // ── Hero animations (auto-play on load) ──────────────────────────────────
  const heroTl = gsap.timeline({ delay: 0.2 });

  heroTl
    .from('.hero-badge', { y: 30, opacity: 0, duration: 0.6, ease: 'power3.out' })
    .from('.hero-title .title-line', {
      y: 60, opacity: 0, duration: 0.8, stagger: 0.12, ease: 'power3.out'
    }, '-=0.3')
    .from('.hero-subtitle', { y: 30, opacity: 0, duration: 0.6, ease: 'power3.out' }, '-=0.4')
    .from('.hero-cta .btn', { y: 20, opacity: 0, duration: 0.5, stagger: 0.1, ease: 'back.out(1.5)' }, '-=0.3')
    .from('.hero-stats', { y: 20, opacity: 0, duration: 0.6, ease: 'power3.out' }, '-=0.2')
    .from('.hero-code', { y: 40, opacity: 0, duration: 0.8, ease: 'power3.out' }, '-=0.4')
    .from('#scroll-indicator', { opacity: 0, duration: 0.5 }, '-=0.2');

  // Turn the opening field into a camera move: each scroll gesture advances
  // the scene like a short 3D website intro.
  gsap.timeline({
    scrollTrigger: {
      trigger: '.hero-section',
      start: 'top top',
      end: '+=760',
      scrub: 0.35,
      pin: true,
      anticipatePin: 1,
    }
  })
    .to('.cinematic-scene', { scale: 1.18, rotationX: 3, yPercent: 7, duration: 1, ease: 'none' })
    .to('.hero-content', { yPercent: -24, scale: 0.88, opacity: 0.15, duration: 0.62, ease: 'none' }, 0)
    .to('.hero-code', { yPercent: -38, rotationY: -8, scale: 0.78, opacity: 0, duration: 0.55, ease: 'none' }, 0.12)
    .to('.field-message', { y: 0, opacity: 1, duration: 0.32, ease: 'none' }, 0.7)
    .to('.scroll-indicator', { opacity: 0, duration: 0.2, ease: 'none' }, 0);

  // ── Section label + title reveal ───────────────────────────────────────────
  document.querySelectorAll('.section-label').forEach(el => {
    gsap.from(el, {
      y: 20, opacity: 0, duration: 0.5, ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 88%', toggleActions: 'play none none none' }
    });
  });

  document.querySelectorAll('.section-title').forEach(el => {
    gsap.from(el, {
      y: 30, opacity: 0, duration: 0.7, ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 88%', toggleActions: 'play none none none' }
    });
  });

  // Section descriptions
  document.querySelectorAll('.section-desc').forEach(el => {
    gsap.from(el, {
      y: 20, opacity: 0, duration: 0.6, ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play none none none' }
    });
  });

  // ── Pain cards ────────────────────────────────────────────────────────────
  document.querySelectorAll('.pain-card').forEach((el, i) => {
    const delay = parseInt(el.style.getPropertyValue('--delay') || '0');
    gsap.from(el, {
      y: 50, opacity: 0, duration: 0.7, delay: delay * 0.1,
      ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 85%', toggleActions: 'play none none none' }
    });
  });

  // ── Feature cards ─────────────────────────────────────────────────────────
  document.querySelectorAll('.feature-card').forEach((el) => {
    const delay = parseInt(el.style.getPropertyValue('--delay') || '0');
    gsap.from(el, {
      y: 50, opacity: 0, duration: 0.7, delay: delay * 0.08,
      ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 85%', toggleActions: 'play none none none' }
    });
  });

  // ── Feature cards stagger within grid ─────────────────────────────────────
  const featuresGrid = document.querySelector('.features-grid');
  if (featuresGrid) {
    gsap.from('.feature-card', {
      y: 40, opacity: 0, duration: 0.6, stagger: 0.1, ease: 'power3.out',
      scrollTrigger: { trigger: featuresGrid, start: 'top 80%', toggleActions: 'play none none none' }
    });
  }

  // ── Steps ─────────────────────────────────────────────────────────────────
  document.querySelectorAll('.step-item').forEach((el) => {
    const delay = parseInt(el.style.getPropertyValue('--delay') || '0');
    gsap.from(el, {
      x: -40, opacity: 0, duration: 0.8, delay: delay * 0.15,
      ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 85%', toggleActions: 'play none none none' }
    });
  });

  // ── Demo console ──────────────────────────────────────────────────────────
  const demoConsole = document.querySelector('.demo-console');
  if (demoConsole) {
    gsap.from(demoConsole, {
      y: 50, opacity: 0, duration: 0.9, ease: 'power3.out',
      scrollTrigger: { trigger: demoConsole, start: 'top 80%', toggleActions: 'play none none none' }
    });
  }

  // ── CTA section ───────────────────────────────────────────────────────────
  const ctaContent = document.querySelector('.cta-content');
  if (ctaContent) {
    gsap.from(ctaContent, {
      y: 40, opacity: 0, duration: 0.8, ease: 'power3.out',
      scrollTrigger: { trigger: ctaContent, start: 'top 85%', toggleActions: 'play none none none' }
    });
  }

  // ── Horizontal line effect on solution section ────────────────────────────
  gsap.from('.solution-bg-gradient', {
    scale: 0.8, opacity: 0, duration: 1.5, ease: 'power2.out',
    scrollTrigger: { trigger: '.solution-section', start: 'top 80%' }
  });
}

// ── Counters ──────────────────────────────────────────────────────────────────
function initCounters() {
  const counters = document.querySelectorAll('.stat-number[data-count]');
  counters.forEach(counter => {
    const target = parseFloat(counter.dataset.count);
    const isFloat = target % 1 !== 0;
    const obj = { val: 0 };

    gsap.to(obj, {
      val: target,
      duration: 2.5,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: counter,
        start: 'top 85%',
        toggleActions: 'play none none none',
        onEnter: () => {
          gsap.to(obj, {
            val: target,
            duration: 2.5,
            ease: 'power2.out',
            onUpdate: () => {
              counter.textContent = isFloat
                ? obj.val.toFixed(1)
                : Math.round(obj.val).toString();
            }
          });
        }
      }
    });
  });
}

// ── Intersection Observer for fade-in fallback ─────────────────────────────────
function initFadeInObserver() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
}

// ── Demo Console ───────────────────────────────────────────────────────────────
async function runDemo() {
  const text = document.getElementById('demo-text')?.value?.trim();
  const output = document.getElementById('demo-output');
  const btn = document.getElementById('demo-run-btn');
  if (!text || !output) return;

  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Running...';

  output.innerHTML = `
    <div class="demo-result" style="text-align:center; padding:32px; color: var(--text-muted);">
      <div class="spinner" style="margin:0 auto 12px;border-top-color:var(--primary)"></div>
      Sending request...
    </div>
  `;

  // Try to use a real model if available, else simulate
  try {
    const models = await api.listModels();
    const model = models.models?.[0];

    if (model) {
      const keys = await api.listKeys(model.id);
      const key = keys.keys?.[0];

      if (key) {
        const result = await api.predict(model.id, [text], key.key);
        renderDemoResult(result, output);
      } else {
        renderSimulatedResult(text, output);
      }
    } else {
      renderSimulatedResult(text, output);
    }
  } catch {
    // Backend not running or no models — simulate a response
    renderSimulatedResult(text, output);
  }

  btn.disabled = false;
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    Run Prediction
  `;
}

function renderDemoResult(result, output) {
  const pred = result.prediction;
  const isSpam = String(pred).toLowerCase().includes('spam') || pred === 1 || pred === '1';
  const label = isSpam ? 'SPAM' : 'HAM (Not Spam)';
  const labelClass = isSpam ? 'result-spam' : 'result-ham';

  output.innerHTML = `
    <div class="demo-result">
      <div style="margin-bottom:12px">
        <span class="result-label">Status:</span>
        <span class="result-success">✓ Prediction successful</span>
      </div>
      <div style="margin-bottom:12px">
        <span class="result-label">Result:</span>
        <span class="${labelClass}" style="font-size:1.1rem">${label}</span>
      </div>
      <div style="margin-bottom:12px">
        <span class="result-label">Raw output:</span>
        <span class="result-value">${JSON.stringify(result.raw_output)}</span>
      </div>
      <div style="margin-bottom:4px">
        <span class="result-label">Task type:</span>
        <span class="result-value">${result.task_type}</span>
      </div>
      <div style="margin-bottom:4px">
        <span class="result-label">Latency:</span>
        <span class="result-value">${result.latency_ms}ms</span>
      </div>
    </div>
  `;
}

function renderSimulatedResult(text, output) {
  // Simple keyword-based simulation
  const spamKeywords = ['free', 'win', 'click', 'prize', 'winner', 'congratulations',
    'urgent', 'limited', 'offer', 'cash', 'money', 'lottery', 'claim', 'reward'];
  const textLower = text.toLowerCase();
  const spamScore = spamKeywords.reduce((score, kw) =>
    score + (textLower.includes(kw) ? 1 : 0), 0) / spamKeywords.length;
  const isSpam = spamScore > 0.08;
  const confidence = Math.min(0.99, 0.5 + spamScore * 5).toFixed(2);
  const label = isSpam ? 'SPAM' : 'HAM (Not Spam)';
  const labelClass = isSpam ? 'result-spam' : 'result-ham';

  output.innerHTML = `
    <div class="demo-result">
      <div style="margin-bottom:12px">
        <span class="result-label">Status:</span>
        <span class="result-success">✓ Simulated prediction (demo mode)</span>
      </div>
      <div style="margin-bottom:12px">
        <span class="result-label">Result:</span>
        <span class="${labelClass}" style="font-size:1.1rem">${label}</span>
        <span style="color:var(--text-muted);font-size:0.8rem"> (confidence: ${confidence})</span>
      </div>
      <div style="margin-bottom:12px">
        <span class="result-label">Detected keywords:</span>
        <span class="result-value">${spamKeywords.filter(k => textLower.includes(k)).join(', ') || 'none'}</span>
      </div>
      <div style="margin-bottom:4px">
        <span class="result-label">Note:</span>
        <span style="color:var(--text-muted);font-size:0.8rem">Upload a real model for accurate predictions</span>
      </div>
    </div>
  `;
}

// ── Upload Page ────────────────────────────────────────────────────────────────
function initUploadPage() {
  const dropzone = document.querySelector('.upload-dropzone');
  const fileInput = document.getElementById('file-input');
  const uploadForm = document.getElementById('upload-form');
  const submitBtn = document.getElementById('submit-btn');
  const filenameDisplay = document.getElementById('filename-display');

  if (!dropzone || !uploadForm) return;

  // Drag and drop
  dropzone.addEventListener('click', () => fileInput?.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      if (filenameDisplay) filenameDisplay.textContent = file.name;
      if (filenameDisplay) filenameDisplay.parentElement.style.display = 'flex';
    }
  });

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (filenameDisplay && file) {
      filenameDisplay.textContent = file.name;
      filenameDisplay.parentElement.style.display = 'flex';
    }
  });

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<div class="spinner"></div> Uploading...';
    }

    const formData = new FormData(uploadForm);

    try {
      const result = await api.uploadModel(formData);
      showUploadSuccess(result);
    } catch (err) {
      showUploadError(err.message);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
          </svg>
          Upload Model
        `;
      }
    }
  });
}

function showUploadSuccess(result) {
  const form = document.getElementById('upload-form');
  const container = document.querySelector('.upload-container');
  if (!container) return;

  // Remove existing result if any
  const existing = document.querySelector('.upload-result');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = 'upload-result success';
  div.innerHTML = `
    <h3>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Model uploaded successfully!
    </h3>
    <p style="font-size:0.9rem;color:var(--text-dim);margin-bottom:8px">
      Your model <strong style="color:var(--text)">${result.name}</strong> is ready.
      Model ID: <code style="font-family:var(--mono);color:var(--accent)">${result.model_id}</code>
    </p>
    <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:8px">
      Task type detected: <strong>${result.task_type}</strong>
    </p>
    <div class="upload-key-box">
      <div>
        <div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:4px">
          Default API Key — save this!
        </div>
        <div class="upload-key-value" id="uploaded-api-key">Loading...</div>
      </div>
      <button class="btn-copy" onclick="loadAndShowKey('${result.model_id}')">Copy Key</button>
    </div>
    <div style="margin-top:16px;display:flex;gap:12px;flex-wrap:wrap">
      <a href="/apikeys.html" class="btn btn-outline btn-sm">Manage API Keys</a>
      <a href="/dashboard.html" class="btn btn-outline btn-sm">View Dashboard</a>
      <button class="btn btn-outline btn-sm" onclick="resetUploadForm()">Upload Another</button>
    </div>
  `;
  container.appendChild(div);

  // Scroll to result
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Load the key
  loadAndShowKey(result.model_id);
}

async function loadAndShowKey(modelId) {
  try {
    const keys = await api.listKeys(modelId);
    const key = keys.keys?.[0];
    if (key) {
      const el = document.getElementById('uploaded-api-key');
      if (el) el.textContent = key.key;
      copyToClipboard(key.key);
    }
  } catch {}
}

function resetUploadForm() {
  const form = document.getElementById('upload-form');
  if (form) form.reset();
  const result = document.querySelector('.upload-result');
  if (result) result.remove();
  const fileName = document.getElementById('filename-display');
  if (fileName) {
    fileName.textContent = '';
    fileName.parentElement.style.display = 'none';
  }
}

function showUploadError(message) {
  const existing = document.querySelector('.form-error');
  if (existing) existing.remove();

  const form = document.getElementById('upload-form');
  const err = document.createElement('div');
  err.className = 'form-error';
  err.textContent = message || 'Upload failed. Please try again.';
  form?.appendChild(err);
  setTimeout(() => err.remove(), 8000);
}

// ── Dashboard Page ─────────────────────────────────────────────────────────────
async function initDashboardPage() {
  const app = document.getElementById('dashboard-app');
  if (!app) return;

  await loadDashboardData();
  // Refresh every 10 seconds
  setInterval(loadDashboardData, 10000);
}

async function loadDashboardData() {
  const app = document.getElementById('dashboard-app');
  if (!app) return;

  try {
    const stats = await api.getStats();
    renderDashboard(app, stats);
  } catch (err) {
    app.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
          </svg>
        </div>
        <h3>Backend not running</h3>
        <p>Start the server with <code style="font-family:var(--mono)">./start.sh</code> to see dashboard data.</p>
        <p style="margin-top:8px">Or run: <code style="font-family:var(--mono)">python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 4500</code></p>
      </div>
    `;
  }
}

function renderDashboard(container, stats) {
  const recentLogs = (stats.recent_logs || []).slice(-20).reverse();

  container.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-card-label">Total Models</div>
        <div class="stat-card-value">${stats.total_models}</div>
        <div class="stat-card-sub">Uploaded</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">API Keys</div>
        <div class="stat-card-value">${stats.total_api_keys}</div>
        <div class="stat-card-sub">${stats.active_api_keys} active</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Total Requests</div>
        <div class="stat-card-value">${stats.total_requests.toLocaleString()}</div>
        <div class="stat-card-sub">Across all models</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Avg Latency</div>
        <div class="stat-card-value">${recentLogs.length ? (recentLogs.reduce((s,l) => s+l.latency_ms, 0)/recentLogs.length).toFixed(1) : '—'}</div>
        <div class="stat-card-sub">ms per request</div>
      </div>
    </div>

    <!-- Models List -->
    <div class="section-block">
      <div class="section-block-header">
        <span class="section-block-title">📦 Uploaded Models</span>
        <a href="/upload.html" class="btn btn-primary btn-sm">+ Upload Model</a>
      </div>
      <div class="section-block-body">
        ${stats.models && stats.models.length > 0 ? `
          <div class="models-list">
            ${stats.models.map(m => `
              <div class="model-card-item" id="model-${m.id}">
                <div class="model-card-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
                  </svg>
                </div>
                <div class="model-card-info">
                  <div class="model-card-name">${m.name}</div>
                  <div class="model-card-meta">
                    <span class="model-card-badge">${m.task_type}</span>
                    <span>${m.request_count} requests</span>
                    <span>${formatBytes(m.size_bytes)}</span>
                    <span>${timeAgo(m.uploaded_at)}</span>
                  </div>
                </div>
                <div class="model-card-actions">
                  <button class="btn-small" onclick="testPredict('${m.id}')">Test Predict</button>
                  <a href="/apikeys.html?model=${m.id}" class="btn-small">Keys</a>
                  <button class="btn-small danger" onclick="deleteModel('${m.id}')">Delete</button>
                </div>
              </div>

              <!-- Inline predict console for this model -->
              <div class="predict-console" id="predict-console-${m.id}" style="display:none;margin:0 24px 16px;border-radius:var(--radius)">
                <div class="predict-console-header">
                  <span style="font-size:0.82rem;font-weight:600">Test: ${m.name}</span>
                  <select id="predict-key-${m.id}" style="margin-left:auto;background:var(--surface2);border:1px solid var(--border2);color:var(--text-dim);padding:4px 10px;border-radius:6px;font-size:0.8rem;font-family:var(--font)">
                    <option value="">Select API key...</option>
                  </select>
                  <button class="btn-small" onclick="document.getElementById('predict-console-${m.id}').style.display='none'" style="margin-left:8px">✕</button>
                </div>
                <div class="predict-console-body">
                  <div class="predict-input-row">
                    <textarea id="predict-input-${m.id}" placeholder='JSON array input, e.g.: ["Hello world"] or [[1,2,3,4]]' rows="2"></textarea>
                    <button class="btn btn-primary" onclick="runPredict('${m.id}')">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      Predict
                    </button>
                  </div>
                  <div id="predict-result-${m.id}"></div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="empty-state">
            <div class="empty-state-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
              </svg>
            </div>
            <h3>No models yet</h3>
            <p>Upload your first ML model to get started.</p>
            <a href="/upload.html" class="btn btn-primary" style="margin-top:16px;display:inline-flex">Upload Model</a>
          </div>
        `}
      </div>
    </div>

    <!-- Recent Logs -->
    <div class="section-block">
      <div class="section-block-header">
        <span class="section-block-title">📊 Recent Predictions</span>
        <span style="font-size:0.78rem;color:var(--text-muted)">Last ${recentLogs.length} requests</span>
      </div>
      <div class="section-block-body" style="overflow-x:auto">
        ${recentLogs.length > 0 ? `
          <table class="log-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Input</th>
                <th>Prediction</th>
                <th>Latency</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${recentLogs.map(l => `
                <tr>
                  <td class="log-time">${new Date(l.timestamp).toLocaleTimeString()}</td>
                  <td><span class="log-input">${l.input_data}</span></td>
                  <td>${l.prediction || '—'}</td>
                  <td>${l.latency_ms}ms</td>
                  <td class="${l.success ? 'log-success' : 'log-error'}">${l.success ? '✓' : '✗'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : `
          <div class="empty-state">
            <div class="empty-state-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
            </div>
            <h3>No predictions yet</h3>
            <p>Prediction logs will appear here once you start using your models.</p>
          </div>
        `}
      </div>
    </div>
  `;

  // Load keys into select dropdowns
  for (const m of (stats.models || [])) {
    loadKeysForModel(m.id);
  }
}

async function loadKeysForModel(modelId) {
  const select = document.getElementById(`predict-key-${modelId}`);
  if (!select) return;
  try {
    const keys = await api.listKeys(modelId);
    select.innerHTML = '<option value="">Select API key...</option>';
    (keys.keys || []).forEach(k => {
      if (k.is_active) {
        const opt = document.createElement('option');
        opt.value = k.key;
        opt.textContent = `${k.label} (${k.purpose})`;
        select.appendChild(opt);
      }
    });
  } catch {}
}

function testPredict(modelId) {
  const console = document.getElementById(`predict-console-${modelId}`);
  if (console) {
    console.style.display = console.style.display === 'none' ? 'block' : 'none';
    console.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function runPredict(modelId) {
  const input = document.getElementById(`predict-input-${modelId}`)?.value?.trim();
  const key = document.getElementById(`predict-key-${modelId}`)?.value;
  const resultDiv = document.getElementById(`predict-result-${modelId}`);
  if (!input || !resultDiv) return;

  let data;
  try {
    data = JSON.parse(input);
    if (!Array.isArray(data)) data = [data];
  } catch {
    data = [input];
  }

  if (!key) {
    resultDiv.innerHTML = '<div class="predict-error-box">Please select an API key first.</div>';
    return;
  }

  resultDiv.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:0.85rem">⏳ Running prediction...</div>';

  try {
    const result = await api.predict(modelId, data, key);
    resultDiv.innerHTML = `
      <div class="predict-result">
        <div style="margin-bottom:8px">
          <span class="result-label">Status:</span>
          <span class="result-success">✓ Success</span>
        </div>
        <div style="margin-bottom:8px">
          <span class="result-label">Prediction:</span>
          <span class="result-value" style="font-size:1rem;font-weight:700">${result.prediction}</span>
        </div>
        <div style="margin-bottom:8px">
          <span class="result-label">Raw output:</span>
          <span class="result-value">${JSON.stringify(result.raw_output)}</span>
        </div>
        <div>
          <span class="result-label">Latency:</span>
          <span class="result-value">${result.latency_ms}ms</span>
        </div>
      </div>
    `;
  } catch (err) {
    resultDiv.innerHTML = `<div class="predict-error-box">Error: ${err.message}</div>`;
  }
}

async function deleteModel(modelId) {
  if (!confirm('Delete this model and all its API keys?')) return;
  try {
    await api.deleteModel(modelId);
    showToast('Model deleted');
    await loadDashboardData();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

// ── API Keys Page ──────────────────────────────────────────────────────────────
async function initAPIKeysPage() {
  const app = document.getElementById('apikeys-app');
  if (!app) return;

  // Load all models for the sidebar
  try {
    const { models } = await api.listModels();
    const urlParams = new URLSearchParams(window.location.search);
    const selectedModelId = urlParams.get('model') || (models[0]?.id || '');

    renderKeysLayout(app, models, selectedModelId);
  } catch {
    renderKeysLayout(app, [], '');
  }
}

function renderKeysLayout(container, models, selectedModelId) {
  container.innerHTML = `
    <div class="keys-layout">
      <!-- Sidebar: model list -->
      <div class="keys-sidebar">
        <div class="sidebar-title">Your Models</div>
        ${models.length > 0 ? models.map(m => `
          <div class="model-list-item ${m.id === selectedModelId ? 'active' : ''}"
               onclick="selectModel('${m.id}')" id="sidebar-model-${m.id}">
            <span class="model-list-dot"></span>
            ${m.name}
          </div>
        `).join('') : `
          <div style="font-size:0.82rem;color:var(--text-muted);padding:8px 0">
            No models yet.
            <a href="/upload.html" style="color:var(--primary)">Upload one</a>
          </div>
        `}
      </div>

      <!-- Main: keys panel -->
      <div class="keys-main" id="keys-main-panel">
        <!-- Keys loaded dynamically -->
      </div>
    </div>
  `;

  if (selectedModelId) {
    loadKeysPanel(selectedModelId);
  }
}

async function selectModel(modelId) {
  // Update sidebar active state
  document.querySelectorAll('.model-list-item').forEach(el => el.classList.remove('active'));
  const active = document.getElementById(`sidebar-model-${modelId}`);
  if (active) active.classList.add('active');

  // Update URL
  const url = new URL(window.location);
  url.searchParams.set('model', modelId);
  window.history.pushState({}, '', url);

  await loadKeysPanel(modelId);
}

async function loadKeysPanel(modelId) {
  const panel = document.getElementById('keys-main-panel');
  if (!panel) return;

  try {
    const { keys } = await api.listKeys(modelId);
    const { models } = await api.listModels();
    const model = models.find(m => m.id === modelId);

    panel.innerHTML = `
      <div class="keys-header">
        <h2>
          ${model?.name || 'Model'} API Keys
          <span style="font-size:0.9rem;font-weight:400;color:var(--text-muted)">
            (${keys.length} key${keys.length !== 1 ? 's' : ''})
          </span>
        </h2>
        <button class="btn btn-primary btn-sm" onclick="showCreateKeyForm('${modelId}')">
          + Generate Key
        </button>
      </div>

      <!-- Create key form (hidden by default) -->
      <div id="create-key-form" class="section-block" style="display:none;margin-bottom:20px">
        <div class="section-block-header">
          <span class="section-block-title">Generate New API Key</span>
        </div>
        <div style="padding:20px;display:flex;flex-direction:column;gap:14px">
          <div class="form-group">
            <label class="form-label">Key Label</label>
            <input type="text" id="new-key-label" class="form-input" placeholder="e.g. Production API Key">
          </div>
          <div class="form-group">
            <label class="form-label">Purpose</label>
            <select id="new-key-purpose" class="form-select">
              <option value="predict">Predict — for inference requests</option>
              <option value="batch">Batch — for batch processing</option>
              <option value="analytics">Analytics — read-only usage stats</option>
            </select>
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-primary btn-sm" onclick="createKey('${modelId}')">Create Key</button>
            <button class="btn-small" onclick="document.getElementById('create-key-form').style.display='none'">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Keys list -->
      <div class="keys-list" id="keys-list-container">
        ${renderKeysList(keys)}
      </div>
    `;
  } catch (err) {
    panel.innerHTML = `<div class="empty-state"><p>Error loading keys: ${err.message}</p></div>`;
  }
}

function renderKeysList(keys) {
  if (!keys.length) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
          </svg>
        </div>
        <h3>No API keys</h3>
        <p>Generate your first API key to start making predictions.</p>
      </div>
    `;
  }

  return keys.map(k => `
    <div class="key-card ${k.is_active ? '' : 'revoked'}">
      <div class="key-info">
        <div class="key-label-text">${k.label || 'Unnamed Key'}</div>
        <div class="key-meta">
          <span>Purpose: ${k.purpose}</span>
          <span>${k.request_count} requests</span>
          <span>Created ${timeAgo(k.created_at)}</span>
          <span class="${k.is_active ? 'log-success' : 'log-error'}">${k.is_active ? '● Active' : '○ Revoked'}</span>
        </div>
        <div class="key-value-full" id="key-value-${k.id}">${k.key}</div>
      </div>
      <div class="key-actions">
        <button class="btn-small" onclick="copyKey('${k.id}', '${k.key}')">Copy</button>
        ${k.is_active ? `
          <button class="btn-small danger" onclick="revokeKey('${k.id}')">Revoke</button>
        ` : ''}
      </div>
    </div>
  `).join('');
}

function showCreateKeyForm(modelId) {
  const form = document.getElementById('create-key-form');
  if (form) {
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function createKey(modelId) {
  const label = document.getElementById('new-key-label')?.value?.trim() || '';
  const purpose = document.getElementById('new-key-purpose')?.value || 'predict';

  try {
    const result = await api.createKey(modelId, purpose, label);
    showToast('API key created!');
    document.getElementById('create-key-form').style.display = 'none';
    document.getElementById('new-key-label').value = '';
    await loadKeysPanel(modelId);
    // Scroll to the new key
    const newKeyEl = document.getElementById(`key-value-${result.id}`);
    if (newKeyEl) newKeyEl.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showToast('Failed to create key: ' + err.message, 'error');
  }
}

function copyKey(keyId, key) {
  copyToClipboard(key);
}

async function revokeKey(keyId) {
  if (!confirm('Revoke this API key? This cannot be undone.')) return;
  try {
    await api.revokeKey(keyId);
    showToast('API key revoked');
    // Find current model from sidebar
    const active = document.querySelector('.model-list-item.active');
    const modelId = active?.id?.replace('sidebar-model-', '') || '';
    if (modelId) await loadKeysPanel(modelId);
  } catch (err) {
    showToast('Revoke failed: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ModelForge — production integration (v2.0, appended)
// Wires the realtime WebSocket channel into the pages above: connection
// badge, event-driven dashboard refresh, toast notifications, and demo key
// auto-discovery. Activated by js/realtime.js (loaded before this file).
// ═══════════════════════════════════════════════════════════════════════════

(function initProductionIntegration() {
  // ── Connection badge in the nav ────────────────────────────────────────
  const badge = document.getElementById('ws-status');
  if (badge && window.MFRealtime) {
    window.MFRealtime.onState((state) => {
      badge.dataset.state = state;
      const label = badge.querySelector('.ws-label');
      if (label) label.textContent = state === 'live' ? 'Live' : (state === 'connecting' ? 'Connecting' : 'Offline');
    });
  }

  // ── Real-time events → page behavior ──────────────────────────────────
  if (window.MFRealtime) {
    const isDashboard = !!document.getElementById('dashboard-app');
    const isUpload = !!document.getElementById('upload-form');
    const isLanding = !!document.getElementById('demo-output');

    if (isDashboard) {
      let refreshTimer = null;
      window.MFRealtime.onEvent((event) => {
        if (['prediction.completed', 'prediction.failed', 'model.uploaded', 'model.deleted',
             'key.created', 'key.revoked', 'server.stats'].includes(event.type)) {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => loadDashboardData(), 400);
        }
      });
    }

    if (isUpload || isLanding) {
      window.MFRealtime.onEvent((event) => {
        if (event.type === 'prediction.completed') {
          const d = event.data || {};
          showToast(`⚡ ${d.model_name || d.model_id}: ${d.prediction} (${d.latency_ms}ms)`);
        } else if (event.type === 'model.deleted') {
          showToast('Model deleted (live)', 'error');
        }
      });
    }

    window.MFRealtime.connect();
  }

  // ── Demo console: surface a real key when available ───────────────────
  const demoKeyDisplay = document.getElementById('demo-key-display');
  if (demoKeyDisplay && window.api) {
    api.listKeys('model_demo_spam_classifier')
      .then(({ keys }) => {
        const active = (keys || []).find(k => k.is_active);
        if (active) {
          demoKeyDisplay.textContent = active.key.slice(0, 14) + '…';
          demoKeyDisplay.title = active.key;
        }
      })
      .catch(() => { /* offline — placeholder stays */ });
  }
})();
