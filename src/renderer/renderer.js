// ============================================================
// 饭仔客户端渲染层 - 重构版
// 合并"我们的密钥"和"手动API"为统一的"API配置"
// ============================================================

const $ = (id) => document.getElementById(id);

// ── 常量 ──
const QUOTA_PER_USD = 10000;
const DEFAULT_PUBLIC_BASE_URL = 'https://api.todonot.com';
const REMOTE_BASE_URL = DEFAULT_PUBLIC_BASE_URL;
const REMOTE_MODEL = 'kr/claude-opus-4.8';

// 去掉末尾的 /v1（及多余斜杠）→ 统一存"干净基址"。
// Claude Code 会自动追加 /v1/messages，地址带 /v1 会导致 /v1/v1 访问不到模型。
function stripV1(s) {
  return String(s || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

// ── 全局状态 ──
let store = { activeId: '', keys: [] };        // 密钥列表和当前选中ID
let statusCache = {};                           // 密钥用量查询缓存
let localRouterRunning = false;                 // 本地9Router运行状态
let customModels = [];                          // 自定义API的模型列表
let activeCustomModel = '';                     // 自定义API当前选中的模型（原 #custom-model 输入框，已改为内存变量）
let deviceFp = null;                            // 设备指纹
let mcpSettings = { enabled: { playwright: true, batch: false } };

// ── 工具函数 ──
const fmtUsd = (q) => '$' + (q / QUOTA_PER_USD).toFixed(2);
const fmtNum = (n) => Number(n).toLocaleString('en-US');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isManualKey(k) {
  return !!k && k.kind === 'manual';
}

function activeKey() {
  return store.keys.find((k) => k.id === store.activeId) || null;
}

function setMsg(elementId, text, kind = '') {
  const el = $(elementId);
  if (!el) return;
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function setMcpStatus(text, kind = '') {
  const el = $('mcp-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'mcp-sub' + (kind ? ' ' + kind : '');
}

function readMcpForm() {
  return {
    enabled: {
      playwright: !!$('mcp-playwright').checked,
      batch: !!$('mcp-batch').checked,
    },
  };
}

function renderMcpSettings() {
  $('mcp-playwright').checked = !!mcpSettings.enabled?.playwright;
  $('mcp-batch').checked = !!mcpSettings.enabled?.batch;
}

async function loadMcpSettings() {
  try {
    mcpSettings = await window.api.mcpRead();
    renderMcpSettings();
    const count = Object.values(mcpSettings.enabled || {}).filter(Boolean).length;
    setMcpStatus(count ? `已启用 ${count} 个` : '未启用', count ? 'ok' : '');
  } catch (e) {
    setMcpStatus('读取失败：' + e.message, 'err');
  }
}

async function applyMcpSettings() {
  const btn = $('btn-mcp-apply');
  btn.disabled = true;
  setMcpStatus('正在应用');
  try {
    mcpSettings = await window.api.mcpApply(readMcpForm());
    renderMcpSettings();
    const count = Object.values(mcpSettings.enabled || {}).filter(Boolean).length;
    setMcpStatus(count ? `已应用 ${count} 个` : '已全部关闭', 'ok');
  } catch (e) {
    setMcpStatus('应用失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── 设备指纹（后台采集） ──
function collectGpuFingerprint() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 128;
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return { vendor: '', renderer: '', hash: '' };

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

    gl.clearColor(0.2, 0.4, 0.6, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);gl_PointSize=64.0;}');
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, 'precision mediump float;void main(){gl_FragColor=vec4(gl_FragCoord.x/256.0,gl_FragCoord.y/128.0,0.7,1.0);}');
    gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.4, -0.4, 0.4, -0.4, 0.0, 0.5]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const pixels = new Uint8Array(256 * 128 * 4);
    gl.readPixels(0, 0, 256, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    let h = 0x811c9dc5;
    const feed = (str) => { for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } };
    feed(String(vendor)); feed(String(renderer));
    for (let i = 0; i < pixels.length; i += 257) { h ^= pixels[i]; h = Math.imul(h, 0x01000193); }
    const hash = (h >>> 0).toString(16).padStart(8, '0');

    return { vendor: String(vendor), renderer: String(renderer), hash };
  } catch {
    return { vendor: '', renderer: '', hash: '' };
  }
}

async function initFingerprint() {
  try {
    const hw = await window.api.fingerprint();
    const gpu = collectGpuFingerprint();
    const enc = new TextEncoder().encode(hw.deviceId + '|' + gpu.vendor + '|' + gpu.renderer + '|' + gpu.hash);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    const finalId = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    deviceFp = { deviceId: finalId, hw: hw.parts, gpu };
  } catch {}
}

// ============================================================
// 渲染函数
// ============================================================

// ── 左侧密钥列表 ──
function renderKeyList() {
  const list = $('keys-list');
  if (!store.keys.length) {
    list.innerHTML = '<div class="keys-empty">还没有密钥<br />点下方按钮添加</div>';
    return;
  }

  list.innerHTML = store.keys.map((k) => {
    const st = statusCache[k.id];
    let metaHtml = '<span class="key-meta dim">未查询</span>';
    let dotCls = 'kdot';

    if (isManualKey(k)) {
      dotCls = 'kdot manual';
      metaHtml = '<span class="key-meta dim">自定义 API</span>';
    } else if (st) {
      if (st.ok) {
        const d = st.data;
        const remain = d.remaining != null ? d.remaining : (d.quota_limit - d.quota_used);
        const exhausted = d.status_flags && (d.status_flags.expired || d.status_flags.quota_exhausted);
        dotCls = exhausted ? 'kdot err' : 'kdot on';
        metaHtml = `<span class="key-meta">余 ${fmtUsd(remain)}</span>`;
      } else {
        dotCls = 'kdot err';
        metaHtml = '<span class="key-meta err">查询失败</span>';
      }
    }

    const active = k.id === store.activeId ? ' active' : '';
    const kindTag = isManualKey(k) ? '<span class="key-kind-tag">自定义</span>' : '';

    return `
      <div class="key-item${active}" data-id="${k.id}">
        <span class="${dotCls}"></span>
        <div class="key-body">
          <div class="key-label"><span>${escapeHtml(k.label)}</span>${kindTag}</div>
          <div class="key-sub"><span class="key-prefix">${escapeHtml(k.prefix)}…</span>${metaHtml}</div>
        </div>
        <button class="key-del" data-del="${k.id}" title="删除">&#x2715;</button>
      </div>`;
  }).join('');
}

// ── 右侧面板切换逻辑 ──
function renderRightPanel() {
  const k = activeKey();

  // 没有选中密钥 → 显示空状态
  if (!k) {
    $('panel-remote').hidden = true;
    $('panel-custom').hidden = true;
    $('panel-empty').hidden = false;
    return;
  }

  // 选中饭仔密钥 → 显示用量面板
  if (!isManualKey(k)) {
    $('panel-remote').hidden = false;
    $('panel-custom').hidden = true;
    $('panel-empty').hidden = true;
    renderRemotePanel(k);
    return;
  }

  // 选中自定义API → 显示编辑表单
  $('panel-remote').hidden = true;
  $('panel-custom').hidden = false;
  $('panel-empty').hidden = true;
  renderCustomPanel(k);
}

// ── 饭仔密钥面板 ──
function renderRemotePanel(k) {
  $('active-prefix').textContent = k.value;
  $('active-baseurl').textContent = REMOTE_BASE_URL;
  $('active-model').textContent = REMOTE_MODEL;

  const st = statusCache[k.id];
  if (st && st.ok) {
    renderDash(st.data);
    $('key-badge').textContent = '有效';
    $('key-badge').className = 'badge ok';
  } else {
    $('dash').hidden = true;
    $('key-badge').textContent = '未查询';
    $('key-badge').className = 'badge';
  }
}

// ── 用量仪表盘 ──
function renderDash(data) {
  $('dash').hidden = false;
  const used = data.quota_used || 0;
  const limit = data.quota_limit || 0;
  const remain = data.remaining != null ? data.remaining : limit - used;
  const today = data.used_today || 0;
  const remainPct = limit > 0 ? Math.max(0, Math.min(100, (remain / limit) * 100)) : 0;

  $('stat-used').textContent = fmtUsd(used);
  $('stat-used').title = fmtNum(used) + ' quota';
  $('stat-remain').textContent = fmtUsd(remain);
  $('stat-remain').title = fmtNum(remain) + ' quota';
  $('stat-today').textContent = fmtUsd(today);
  $('stat-rpm').textContent = data.effective_rpm != null ? data.effective_rpm : '—';

  const fill = $('usage-fill');
  $('usage-pct').textContent = '剩余 ' + remainPct.toFixed(1) + '%';
  fill.style.width = remainPct + '%';
  fill.className = 'usage-bar-fill' + (remainPct < 10 ? ' low' : remainPct < 30 ? ' mid' : '');
  $('usage-name').textContent = `剩余 ${fmtUsd(remain)} / ${fmtUsd(limit)}`;

  const models = (data.allowed_models || []).map((m) =>
    `<span class="model-chip" title="${escapeHtml(m.display_name || '')}">${escapeHtml(m.slug)}</span>`
  ).join('');
  $('models-list').innerHTML = models || '<span class="model-chip">—</span>';

  const dot = $('conn-dot'), ct = $('conn-text');
  if (data.status_flags && (data.status_flags.expired || data.status_flags.quota_exhausted)) {
    dot.className = 'dot-ok err';
    ct.textContent = data.status_flags.expired ? '已过期' : '额度耗尽';
  } else {
    dot.className = 'dot-ok on';
    ct.textContent = '已连接';
  }
}

// ── 自定义API编辑面板 ──
function renderCustomPanel(k) {
  $('custom-title').textContent = k.label || '自定义 API';
  $('custom-badge').textContent = '已保存';
  $('custom-badge').className = 'badge ok';

  $('custom-label').value = k.label || '';
  $('custom-baseurl').value = k.baseUrl || DEFAULT_PUBLIC_BASE_URL;
  $('custom-apikey').value = k.value || '';
  activeCustomModel = String(k.model || k.claudeModel || k.codexModel || '');

  // 加载模型列表（兼容旧字段：claudeModel/codexModel 合并进 models）
  customModels = Array.isArray(k.models) ? [...k.models] : [];
  if (activeCustomModel && !customModels.includes(activeCustomModel)) customModels.push(activeCustomModel);
  if (k.claudeModel && !customModels.includes(k.claudeModel)) customModels.push(k.claudeModel);
  if (k.codexModel && !customModels.includes(k.codexModel)) customModels.push(k.codexModel);
  customModels = [...new Set(customModels.map(m => String(m).trim()).filter(Boolean))].sort();
  renderCustomModels();
}

// ── 自定义模型列表 ──
function renderCustomModels() {
  const box = $('custom-models');
  if (!customModels.length) {
    box.innerHTML = '<div class="empty-hint">还没有模型，先检测或手动添加</div>';
    return;
  }

  const activeModel = activeCustomModel.trim();
  box.innerHTML = customModels.map((m) => {
    const isActive = m === activeModel;
    const cls = 'model-chip-btn' + (isActive ? ' active' : '');
    return `<button class="${cls}" data-model="${escapeHtml(m)}" title="点击选择：${escapeHtml(m)}">${escapeHtml(m)}</button>`;
  }).join('');
}

// ============================================================
// 密钥操作
// ============================================================

// ── 选中密钥 ──
async function selectKey(id) {
  store = await window.api.keysSelect(id);
  renderKeyList();
  renderRightPanel();

  // 如果是饭仔密钥且没缓存，静默查询用量
  const k = activeKey();
  if (k && !isManualKey(k) && !statusCache[k.id]) {
    queryRemoteKey({ silent: true });
  }
}

// ── 添加密钥 ──
async function addKey() {
  const inp = $('add-input');
  const value = inp.value.trim();
  if (!value) {
    setMsg('msg-remote', '请粘贴 API Key 再添加', 'err');
    inp.focus();
    return;
  }

  try {
    const res = await window.api.keysAdd(value);
    store = res.store;
    inp.value = '';
    renderKeyList();
    renderRightPanel();
    setMsg('msg-remote', '密钥已添加', 'ok');

    // 自动选中并查询
    if (store.activeId) queryRemoteKey();
  } catch (e) {
    setMsg('msg-remote', '添加失败：' + e.message, 'err');
  }
}

// ── 删除密钥 ──
async function removeKey(id) {
  const key = store.keys.find(k => k.id === id);
  if (!key) return;

  if (!confirm(`确定要删除密钥"${key.label}"吗？`)) return;

  try {
    store = await window.api.keysRemove(id);
    delete statusCache[id];
    renderKeyList();
    renderRightPanel();
    setMsg('msg-remote', '密钥已删除', 'ok');
  } catch (e) {
    setMsg('msg-remote', '删除失败：' + e.message, 'err');
  }
}

// ── 查询饭仔密钥用量 ──
async function queryRemoteKey({ silent = false } = {}) {
  const k = activeKey();
  if (!k || isManualKey(k)) return;

  if (!silent) {
    setMsg('msg-remote', '查询中…');
    $('key-badge').textContent = '查询中';
    $('key-badge').className = 'badge';
  }

  try {
    const data = await window.api.keyStatus(k.value);
    statusCache[k.id] = { ok: true, data };
    renderDash(data);
    renderKeyList();
    $('key-badge').textContent = '有效';
    $('key-badge').className = 'badge ok';
    if (!silent) setMsg('msg-remote', '查询成功', 'ok');
  } catch (e) {
    statusCache[k.id] = { ok: false, error: e.message };
    renderKeyList();
    $('key-badge').textContent = '无效';
    $('key-badge').className = 'badge err';
    $('conn-dot').className = 'dot-ok err';
    $('conn-text').textContent = '连接失败';
    setMsg('msg-remote', '查询失败：' + e.message, 'err');
  }
}

// ── 批量刷新所有密钥 ──
async function refreshAllKeys() {
  if (!store.keys.length) return;

  const btn = $('btn-refresh-all');
  btn.classList.add('spin');
  setMsg('msg-remote', '正在刷新全部密钥用量…');

  try {
    statusCache = await window.api.keysStatusAll();
    renderKeyList();

    const k = activeKey();
    if (k && !isManualKey(k) && statusCache[k.id]?.ok) {
      renderDash(statusCache[k.id].data);
    }

    setMsg('msg-remote', '已刷新全部用量', 'ok');
  } catch (e) {
    setMsg('msg-remote', '刷新失败：' + e.message, 'err');
  } finally {
    btn.classList.remove('spin');
  }
}

// ============================================================
// 自定义API操作
// ============================================================

// ── 新建自定义API配置 ──
function newCustomConfig() {
  // 取消当前选中，清空表单
  store.activeId = '';
  renderKeyList();

  $('panel-remote').hidden = true;
  $('panel-custom').hidden = false;
  $('panel-empty').hidden = true;

  $('custom-title').textContent = '新建自定义 API';
  $('custom-badge').textContent = '未保存';
  $('custom-badge').className = 'badge';

  $('custom-label').value = '';
  $('custom-baseurl').value = DEFAULT_PUBLIC_BASE_URL;
  $('custom-apikey').value = '';
  activeCustomModel = '';
  customModels = [];
  renderCustomModels();

  setMsg('msg-custom', '请填写自定义 API 配置', 'ok');
  $('custom-label').focus();
}

// ── 保存自定义API配置 ──
async function saveCustomConfig() {
  const label = $('custom-label').value.trim();
  const baseUrl = stripV1($('custom-baseurl').value);
  const apiKey = $('custom-apikey').value.trim();
  const model = activeCustomModel.trim();

  if (!label) {
    setMsg('msg-custom', '请填写名称', 'err');
    $('custom-label').focus();
    return;
  }

  if (!apiKey) {
    setMsg('msg-custom', '请填写 API Key', 'err');
    $('custom-apikey').focus();
    return;
  }

  const payload = {
    id: store.activeId || '',  // 空ID表示新建，有ID表示编辑
    label,
    baseUrl: baseUrl || DEFAULT_PUBLIC_BASE_URL,
    apiKey,
    model,
    models: customModels,
  };

  const btn = $('btn-save-custom');
  btn.disabled = true;
  setMsg('msg-custom', payload.id ? '正在保存修改…' : '正在保存新配置…');

  try {
    const res = await window.api.keysUpsertManual(payload);
    store = res.store;
    renderKeyList();
    renderRightPanel();
    setMsg('msg-custom', '保存成功', 'ok');
  } catch (e) {
    setMsg('msg-custom', '保存失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── 检测并拉取模型列表 ──
async function detectModels() {
  const baseUrl = $('custom-baseurl').value.trim();
  const apiKey = $('custom-apikey').value.trim();

  if (!apiKey) {
    setMsg('msg-custom', '请先填写 API Key', 'err');
    $('custom-apikey').focus();
    return;
  }

  const btn = $('btn-detect-models');
  btn.disabled = true;
  $('custom-badge').textContent = '检测中';
  $('custom-badge').className = 'badge';
  setMsg('msg-custom', '正在检测地址并拉取模型列表…');

  try {
    const res = await window.api.manualModels({ baseUrl, apiKey });
    $('custom-baseurl').value = stripV1(res.baseUrl);   // 回填干净基址（去掉检测命中的 /v1）

    // 刷新模型列表：以服务器返回为准，清空旧的残留模型
    customModels = [...new Set(res.models.map(m => String(m).trim()).filter(Boolean))].sort();
    // 当前选中的模型若已不在新列表里，则清空选择
    if (activeCustomModel.trim() && !customModels.includes(activeCustomModel.trim())) {
      activeCustomModel = '';
    }
    renderCustomModels();

    // 如果没设置模型，自动选第一个
    if (!activeCustomModel.trim() && customModels.length > 0) {
      selectModel(customModels[0]);
    }

    $('custom-badge').textContent = '可用';
    $('custom-badge').className = 'badge ok';
    setMsg('msg-custom', `检测成功：${res.baseUrl}，找到 ${res.models.length} 个模型`, 'ok');
  } catch (e) {
    $('custom-badge').textContent = '失败';
    $('custom-badge').className = 'badge err';
    setMsg('msg-custom', '检测失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── 添加单个模型 ──
function addModel() {
  const input = $('input-add-model');
  const model = input.value.trim();

  if (!model) {
    setMsg('msg-custom', '请填写模型名', 'err');
    input.focus();
    return;
  }

  if (customModels.includes(model)) {
    setMsg('msg-custom', '模型已存在', 'err');
    return;
  }

  customModels.push(model);
  customModels.sort();
  renderCustomModels();
  selectModel(model);
  input.value = '';
  setMsg('msg-custom', `已添加模型：${model}`, 'ok');
}

// ── 选择模型 ──
function selectModel(model) {
  activeCustomModel = model;
  renderCustomModels();
  setMsg('msg-custom', `已选择模型：${model}`, 'ok');
}

// ── 测试模型 ──
async function testModel() {
  const baseUrl = $('custom-baseurl').value.trim();
  const apiKey = $('custom-apikey').value.trim();
  const model = activeCustomModel.trim();

  if (!apiKey) {
    setMsg('msg-custom', '请先填写 API Key', 'err');
    $('custom-apikey').focus();
    return;
  }

  if (!model) {
    setMsg('msg-custom', '请先选择或填写模型', 'err');
    return;
  }

  const btn = $('btn-test-model');
  btn.disabled = true;
  $('custom-badge').textContent = '测试中';
  $('custom-badge').className = 'badge';
  setMsg('msg-custom', '正在发送真实请求检测模型…');

  try {
    const res = await window.api.manualTestModel({ baseUrl, apiKey, model });
    $('custom-baseurl').value = stripV1(res.baseUrl);   // 回填干净基址
    $('custom-badge').textContent = '模型可用';
    $('custom-badge').className = 'badge ok';
    const reply = res.reply ? `，返回：${res.reply}` : '';
    setMsg('msg-custom', `模型检测成功：${res.model} (${res.endpoint})${reply}`, 'ok');
  } catch (e) {
    $('custom-badge').textContent = '模型失败';
    $('custom-badge').className = 'badge err';
    setMsg('msg-custom', '测试失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// 启动函数
// ============================================================

// ── 启动 Claude Code（饭仔密钥） ──
// ── 检查更新（手动触发）：升级 CLI + VS Code 扩展 ──
async function checkForUpdates() {
  const btn = $('btn-check-update');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '↻ 检查中…';
  showLog();
  try {
    await window.api.checkUpdate();
    btn.textContent = '✓ 已是最新';
    setTimeout(() => { btn.textContent = original; }, 3000);
  } catch (e) {
    btn.textContent = original;
    alert('检查更新失败：' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
  }
}

async function launchRemoteClaude() {
  const k = activeKey();
  if (!k || isManualKey(k)) {
    setMsg('msg-remote', '请先选择一个饭仔密钥', 'err');
    return;
  }

  const btn = $('btn-launch');
  btn.disabled = true;
  showLog();
  setMsg('msg-remote', '正在启动 VS Code（首次会下载，请稍候）…');

  try {
    await window.api.launchRemote();
    setMsg('msg-remote', 'VS Code 已启动，点左侧 Claude 图标即可对话', 'ok');
  } catch (e) {
    setMsg('msg-remote', '启动失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── 启动 Claude Code（自定义API） ──
async function launchCustomClaude() {
  const payload = getCustomPayload();
  if (!payload) return;

  const btn = $('btn-launch-claude');
  btn.disabled = true;
  showLog();
  $('custom-badge').textContent = '启动中';
  $('custom-badge').className = 'badge';
  setMsg('msg-custom', '正在用自定义 API 启动 Claude Code…');

  try {
    await window.api.launchManualClaude(payload);
    $('custom-badge').textContent = '已启动';
    $('custom-badge').className = 'badge ok';
    setMsg('msg-custom', 'Claude Code 已启动', 'ok');
  } catch (e) {
    $('custom-badge').textContent = '失败';
    $('custom-badge').className = 'badge err';
    setMsg('msg-custom', '启动失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── 启动 Codex（自定义API） ──
async function launchCustomCodex() {
  const payload = getCustomPayload();
  if (!payload) return;

  const btn = $('btn-launch-codex-custom');
  btn.disabled = true;
  showLog();
  $('custom-badge').textContent = '启动中';
  $('custom-badge').className = 'badge';
  setMsg('msg-custom', '正在用自定义 API 启动 Codex…');

  try {
    await window.api.launchManualCodex(payload);
    $('custom-badge').textContent = '已启动';
    $('custom-badge').className = 'badge ok';
    setMsg('msg-custom', 'Codex 已启动', 'ok');
  } catch (e) {
    $('custom-badge').textContent = '失败';
    $('custom-badge').className = 'badge err';
    setMsg('msg-custom', '启动失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── 获取自定义API配置 ──
function getCustomPayload() {
  const baseUrl = stripV1($('custom-baseurl').value);
  const apiKey = $('custom-apikey').value.trim();
  const model = activeCustomModel.trim();

  if (!apiKey) {
    setMsg('msg-custom', '请先填写 API Key', 'err');
    $('custom-apikey').focus();
    return null;
  }

  return {
    id: store.activeId || '',
    label: $('custom-label').value.trim(),
    baseUrl: baseUrl || DEFAULT_PUBLIC_BASE_URL,
    apiKey,
    model,
    models: customModels,
  };
}

// ============================================================
// 本地 9Router
// ============================================================

async function launchLocalWithVSCode() {
  const btn = $('btn-launch-local');
  btn.disabled = true;
  showLog();
  setMsg('msg-local', '正在启动本地 9Router（首次需下载运行时，约 1-2 分钟）…');

  try {
    const r = await window.api.launchLocal();
    showLocalConn(r);
    setLocalRouterRunning(true);
    setMsg('msg-local', '9Router 已启动，VS Code 已打开', 'ok');
  } catch (e) {
    setMsg('msg-local', '启动失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function toggleRouter() {
  const btn = $('btn-router-only');
  btn.disabled = true;
  showLog();

  try {
    if (localRouterRunning) {
      setMsg('msg-local', '正在停止本地 9Router…');
      const r = await window.api.stopRouter();
      setLocalRouterRunning(false);
      setMsg('msg-local', '9Router 已停止', 'ok');
      if (!r || !r.stopped) setMsg('msg-local', '没有检测到本启动器管理的 9Router', 'ok');
    } else {
      setMsg('msg-local', '正在启动本地 9Router…');
      const r = await window.api.startRouterOnly();
      showLocalConn(r);
      setLocalRouterRunning(true);
      setMsg('msg-local', '9Router 已启动，可在任意工具填入上面的地址和 Key', 'ok');
    }
  } catch (e) {
    setMsg('msg-local', (localRouterRunning ? '停止失败：' : '启动失败：') + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function showLocalConn(r) {
  if (!r) return;
  $('local-conn').hidden = false;
  setLocalUrlLink('local-baseurl', r.baseUrl);
  if (r.lanUrl) {
    setLocalUrlLink('local-lanurl', r.lanUrl);
    $('local-lan-row').hidden = false;
  } else {
    setLocalUrlLink('local-lanurl', '');
    $('local-lan-row').hidden = true;
  }
  if (r.apiKey) $('local-apikey').textContent = r.apiKey;
}

function setLocalUrlLink(id, value) {
  const el = $(id);
  const url = value || '';
  el.textContent = url || '—';
  el.href = url || '#';
  el.title = url ? '点击在浏览器打开' : '';
}

// ── 扫描本机 Kiro 凭证 ──
async function scanKiroCredential() {
  const btn = $('btn-scan-kiro');
  btn.disabled = true;
  setMsg('msg-local', '正在扫描本机 Kiro 凭证…');

  try {
    const result = await window.api.scanKiroCredential();
    $('kiro-cred-result').hidden = false;
    $('kiro-email').textContent = result.email || 'unknown';
    $('kiro-auth-method').textContent = `${result.authMethod} (${result.provider})`;
    $('kiro-region').textContent = result.region;
    $('kiro-expires').textContent = result.expiresAt ? new Date(result.expiresAt).toLocaleString() : '—';
    $('kiro-refresh-token').textContent = (result.refreshToken || '').slice(0, 20) + '…';
    $('kiro-refresh-token').title = result.refreshToken || '';

    setMsg('msg-local', `凭证扫描成功：${result.email} (${result.provider})`, 'ok');
  } catch (e) {
    $('kiro-cred-result').hidden = true;
    setMsg('msg-local', '扫描失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function setLocalRouterRunning(running) {
  localRouterRunning = running;
  const badge = $('router-badge');
  const btn = $('btn-router-only');
  if (running) {
    badge.textContent = '运行中';
    badge.className = 'badge ok';
    btn.textContent = '关闭路由器';
    btn.className = 'btn-danger';
  } else {
    badge.textContent = '未启动';
    badge.className = 'badge';
    btn.textContent = '仅启动路由器';
    btn.className = 'btn-primary';
  }
}

// ============================================================
// 界面切换和辅助
// ============================================================

let currentMode = 'api';

function switchMode(mode) {
  currentMode = mode;
  $('tab-api').classList.toggle('active', mode === 'api');
  $('tab-local').classList.toggle('active', mode === 'local');
  $('tab-mcp').classList.toggle('active', mode === 'mcp');
  $('tab-credentials').classList.toggle('active', mode === 'credentials');
  $('view-api').hidden = mode !== 'api';
  $('view-local').hidden = mode !== 'local';
  $('view-mcp').hidden = mode !== 'mcp';
  $('view-credentials').hidden = mode !== 'credentials';
  // 切到凭证 tab 时自动加载列表
  if (mode === 'credentials') loadCredentials();
}

function showLog() {
  $('logbox').hidden = false;
  $('logbox-body').textContent = '';
  resetLaunchProgress();
}

function appendLog(line) {
  const body = $('logbox-body');
  body.textContent += (body.textContent ? '\n' : '') + line;
  body.scrollTop = body.scrollHeight;
}

function resetLaunchProgress() {
  const wrap = $('launch-progress');
  const fill = $('progress-fill');
  if (!wrap || !fill) return;
  wrap.hidden = true;
  $('progress-title').textContent = '准备中';
  $('progress-label').textContent = '0%';
  fill.className = 'progress-fill';
  fill.style.width = '0%';
}

function updateLaunchProgress(payload = {}) {
  const wrap = $('launch-progress');
  const fill = $('progress-fill');
  if (!wrap || !fill) return;

  wrap.hidden = false;
  const phaseTitle = payload.phase === 'extract'
    ? '解压中'
    : payload.phase === 'install'
      ? '安装中'
      : '下载中';
  $('progress-title').textContent = payload.title || phaseTitle;

  if (payload.percent == null) {
    fill.className = 'progress-fill indeterminate';
    fill.style.width = '';
    $('progress-label').textContent = payload.label || '处理中…';
    return;
  }

  const pct = Math.max(0, Math.min(100, Number(payload.percent) || 0));
  fill.className = 'progress-fill';
  fill.style.width = pct.toFixed(1) + '%';
  $('progress-label').textContent = `${pct.toFixed(pct >= 100 ? 0 : 1)}%${payload.label ? ' · ' + payload.label : ''}`;
}

async function openLocalUrl(value) {
  const url = String(value || '').trim();
  if (!url || url === '—') return;
  try {
    await window.api.openUrl(url);
  } catch (e) {
    setMsg('msg-local', '打开失败：' + e.message, 'err');
  }
}

// ============================================================
// 账号凭证管理
// ============================================================

// 记录每个账号最近一次已知的超额状态（ENABLED/DISABLED/''），供开关按钮取反用。
// 用文件路径当 key，避免把带反斜杠的路径塞进 CSS 选择器（Windows 下匹配不到）。
const credOverageState = {};

async function loadCredentials() {
  const list = $('cred-list');
  // 更新代理状态指示器
  updateProxyIndicator();
  try {
    const accounts = await window.api.kiroListCredentials();
    if (!accounts || accounts.length === 0) {
      list.innerHTML = '<div class="keys-empty">未找到凭证文件<br />点击「添加凭证」导入</div>';
      return;
    }
    list.innerHTML = accounts.map((a) => renderCredCard(a)).join('');
    // 绑定超额开关事件（真实状态由 toggleOverage 内部查询后取反）
    list.querySelectorAll('[data-overage-toggle]').forEach((btn) => {
      btn.onclick = () => toggleOverage(btn.getAttribute('data-overage-toggle'));
    });
    // 绑定单个刷新按钮
    list.querySelectorAll('[data-refresh-usage]').forEach((btn) => {
      btn.onclick = () => refreshSingleUsage(btn.getAttribute('data-refresh-usage'));
    });
    // 绑定删除按钮
    list.querySelectorAll('[data-cred-delete]').forEach((btn) => {
      btn.onclick = () => deleteCredential(btn.getAttribute('data-cred-delete'));
    });
    // 绑定启用/禁用开关
    list.querySelectorAll('[data-cred-enable]').forEach((btn) => {
      btn.onclick = () => toggleCredEnabled(btn.getAttribute('data-cred-enable'), btn.getAttribute('data-cred-enabled') === '1');
    });
  } catch (e) {
    list.innerHTML = `<div class="keys-empty">加载失败：${e.message}</div>`;
  }
}

// 判断凭证 token 是否已过期（expiresAt 为 epoch 秒；无值视为未知，不标红）
function isCredExpired(account) {
  const exp = Number(account.expiresAt || 0);
  if (!exp) return false;
  return Math.floor(Date.now() / 1000) >= exp;
}

function renderCredCard(account) {
  const email = account.email || '未知账号';
  const method = account.authMethod || 'social';
  const enabled = account.enabled !== false;
  const fileId = account.filePath || account.id || '';
  const format = account.format === 'kirogo' ? 'Kiro-Go' : 'CLIProxyAPI';
  return `
    <div class="cred-card ${enabled ? '' : 'cred-disabled'}">
      <div class="cred-card-head">
        <div class="cred-email">${escHtml(email)}</div>
        <div class="cred-card-badges">
          <span class="badge cred-format">${format}</span>
          <button class="cred-del-btn" data-cred-delete="${escAttr(fileId)}" title="删除此凭证" aria-label="删除">&times;</button>
        </div>
      </div>
      <div class="cred-meta">
        <span>认证：${escHtml(method)}</span>
        <span>区域：${escHtml(account.region || 'us-east-1')}</span>
      </div>
      <div class="cred-usage" id="cred-usage-${cssId(fileId)}">
        <span class="cred-usage-label">用量：</span>
        <span class="cred-usage-value">点击刷新查看</span>
      </div>
      <div class="cred-actions-row">
        <button class="btn-ghost" data-refresh-usage="${escAttr(fileId)}">刷新用量</button>
        <button class="btn-ghost" id="cred-overage-${cssId(fileId)}" data-overage-toggle="${escAttr(fileId)}">超额：—</button>
        <button class="btn-ghost" data-cred-enable="${escAttr(fileId)}" data-cred-enabled="${enabled ? '1' : '0'}">${enabled ? '禁用账号' : '启用账号'}</button>
      </div>
    </div>
  `;
}

// 更新某账号超额按钮的显示（开/关/未知），并记录状态。用稳定 DOM id 定位，绕开路径选择器问题。
function updateOverageButton(fileId, status) {
  const s = (status || '').toUpperCase();
  credOverageState[fileId] = s;
  const btn = document.getElementById(`cred-overage-${cssId(fileId)}`);
  if (!btn) return;
  if (s === 'ENABLED') {
    btn.textContent = '超额：开';
    btn.className = 'btn-ghost overage-on';
  } else if (s === 'DISABLED') {
    btn.textContent = '超额：关';
    btn.className = 'btn-ghost overage-off';
  } else {
    btn.textContent = '超额：—';
    btn.className = 'btn-ghost';
  }
}

async function refreshSingleUsage(fileId) {
  const elId = `cred-usage-${cssId(fileId)}`;
  const el = document.getElementById(elId);
  if (el) {
    const valEl = el.querySelector('.cred-usage-value');
    if (valEl) valEl.textContent = '查询中…';
  }
  try {
    const info = await window.api.kiroFetchUsage(fileId);
    if (el) {
      const valEl = el.querySelector('.cred-usage-value');
      const pct = info.usageLimit > 0 ? Math.round(info.usagePercent * 100) : 0;
      if (valEl) {
        valEl.textContent = `${info.usageCurrent}/${info.usageLimit} (${pct}%) | ${info.subscriptionType || 'FREE'} | 超额: ${info.overageStatus || 'UNKNOWN'}`;
      }
    }
    // 更新超额按钮状态（用稳定 DOM id，不再用含反斜杠的路径拼 CSS 选择器）
    updateOverageButton(fileId, info.overageStatus);
  } catch (e) {
    if (el) {
      const valEl = el.querySelector('.cred-usage-value');
      if (valEl) valEl.textContent = '查询失败：' + e.message;
    }
  }
}

async function refreshAllCredUsage() {
  const btn = $('btn-cred-refresh');
  if (btn && btn.disabled) return;  // 防连点
  if (btn) { btn.disabled = true; btn.textContent = '刷新中…'; }
  try {
    const accounts = await window.api.kiroListCredentials();
    // 并行刷新，互不影响（一个失败不阻塞其他）
    await Promise.allSettled(
      accounts.map((a) => refreshSingleUsage(a.filePath || a.id))
    );
  } catch (e) {
    setMsg('msg-cred', '刷新失败：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '刷新用量'; }
  }
}

async function toggleOverage(fileId) {
  const btn = document.getElementById(`cred-overage-${cssId(fileId)}`);
  if (btn && btn.disabled) return;
  if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
  try {
    // 先查真实状态再取反，修复"只能开不能关"（不依赖之前是否点过刷新）
    let current = credOverageState[fileId];
    if (current !== 'ENABLED' && current !== 'DISABLED') {
      try {
        const snap = await window.api.kiroFetchOverage(fileId);
        current = (snap.status || '').toUpperCase();
      } catch { current = 'DISABLED'; }  // 查不到按未开启处理
    }
    const newState = current !== 'ENABLED';
    const snap = await window.api.kiroSetOverage(fileId, newState);
    updateOverageButton(fileId, snap.status);
    setMsg('msg-cred', `超额已${(snap.status || '').toUpperCase() === 'ENABLED' ? '开启' : '关闭'}`, 'ok');
  } catch (e) {
    setMsg('msg-cred', e.message || '操作失败', 'err');
    updateOverageButton(fileId, credOverageState[fileId]);  // 恢复按钮显示
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 启用/禁用账号：写回 json 文件的 enabled 字段
async function toggleCredEnabled(fileId, currentlyEnabled) {
  try {
    await window.api.kiroSetEnabled(fileId, !currentlyEnabled);
    setMsg('msg-cred', `账号已${!currentlyEnabled ? '启用' : '禁用'}`, 'ok');
    loadCredentials();
  } catch (e) {
    setMsg('msg-cred', e.message || '操作失败', 'err');
  }
}

// 一键把 creds/ 凭证导入运行中的本地 9router
async function importCredsToRouter() {
  const btn = $('btn-cred-import');
  if (btn && btn.disabled) return;
  if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
  setMsg('msg-cred', '正在导入到 9router（服务端刷新 token，可能需要十几秒）…', '');
  try {
    const r = await window.api.kiroImportToRouter();
    const failLines = (r.details || [])
      .filter((d) => d.status === 'failed')
      .map((d) => `· ${d.email || d.file}：${d.reason}`)
      .join('\n');
    const msg = r.message + (failLines ? '\n' + failLines : '');
    setMsg('msg-cred', msg, r.failed > 0 ? 'err' : 'ok');
    updateProxyIndicator();
    loadCredentials();
  } catch (e) {
    setMsg('msg-cred', '导入失败：' + (e.message || e), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '导入到 9router'; }
  }
}

async function saveCredential() {
  const raw = $('cred-add-json').value.trim();
  if (!raw) { setMsg('msg-cred', '请粘贴凭证 JSON 内容', 'err'); return; }
  try {
    JSON.parse(raw); // 验证 JSON 格式
  } catch {
    setMsg('msg-cred', 'JSON 格式无效，请检查', 'err'); return;
  }
  try {
    await window.api.kiroSaveCredential(raw);
    $('cred-add-panel').hidden = true;
    $('cred-list').hidden = false;
    setMsg('msg-cred', '凭证已保存', 'ok');
    loadCredentials();
  } catch (e) {
    setMsg('msg-cred', '保存失败：' + e.message, 'err');
  }
}

async function deleteCredential(fileId) {
  if (!confirm('确认删除此凭证？')) return;
  try {
    await window.api.kiroDeleteCredential(fileId);
    loadCredentials();
  } catch (e) {
    setMsg('msg-cred', '删除失败：' + e.message, 'err');
  }
}

function escHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escAttr(s) { return escHtml(s); }
function cssId(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_'); }

async function updateProxyIndicator() {
  const el = $('proxy-indicator');
  if (!el) return;
  try {
    const proxy = await window.api.kiroGetProxy();
    if (proxy) {
      el.textContent = '🟢 代理: ' + proxy;
      el.title = '已通过代理请求: ' + proxy;
      el.className = 'proxy-indicator proxy-ok';
    } else {
      el.textContent = '🔴 无代理';
      el.title = '未检测到代理，API 请求可能失败';
      el.className = 'proxy-indicator proxy-none';
    }
  } catch {
    el.textContent = '⚠️ 代理检测失败';
    el.className = 'proxy-indicator proxy-none';
  }
}

// ============================================================
// 事件绑定
// ============================================================

function bindEvents() {
  // ── 标题栏 ──
  $('btn-min').onclick = () => window.api.winMinimize();
  $('btn-close').onclick = () => window.api.winClose();

  // ── 模式切换 ──
  $('tab-api').onclick = () => switchMode('api');
  $('tab-local').onclick = () => switchMode('local');
  $('tab-mcp').onclick = () => switchMode('mcp');
  $('tab-credentials').onclick = () => switchMode('credentials');
  $('btn-mcp-apply').onclick = applyMcpSettings;

  // ── 账号凭证操作 ──
  $('btn-cred-refresh').onclick = refreshAllCredUsage;
  $('btn-cred-import').onclick = importCredsToRouter;
  $('btn-cred-add').onclick = () => {
    $('cred-list').hidden = true;
    $('cred-add-panel').hidden = false;
    $('cred-add-json').value = '';
    $('cred-add-json').focus();
  };
  $('btn-cred-save').onclick = saveCredential;
  $('btn-cred-cancel').onclick = () => {
    $('cred-add-panel').hidden = true;
    $('cred-list').hidden = false;
  };

  // ── 密钥列表操作 ──
  $('keys-list').addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) {
      e.stopPropagation();
      removeKey(delBtn.getAttribute('data-del'));
      return;
    }

    const item = e.target.closest('.key-item');
    if (item) selectKey(item.getAttribute('data-id'));
  });

  $('btn-refresh-all').onclick = refreshAllKeys;
  $('btn-add-key').onclick = addKey;
  $('add-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addKey();
  });
  $('btn-new-custom-sidebar').onclick = newCustomConfig;
  $('btn-shop').onclick = () => window.api.openShop();

  // ── 饭仔密钥面板 ──
  $('btn-query').onclick = () => queryRemoteKey();
  $('btn-copy-key').onclick = async () => {
    const k = activeKey();
    if (!k) return;
    try {
      await navigator.clipboard.writeText(k.value);
      setMsg('msg-remote', '密钥已复制到剪贴板', 'ok');
    } catch {
      setMsg('msg-remote', '复制失败', 'err');
    }
  };
  $('btn-launch').onclick = launchRemoteClaude;
  $('btn-check-update').onclick = checkForUpdates;

  // ── 自定义API面板 ──
  $('btn-new-custom-empty').onclick = newCustomConfig;
  $('btn-save-custom').onclick = saveCustomConfig;
  $('btn-detect-models').onclick = detectModels;
  $('btn-add-model').onclick = addModel;
  $('input-add-model').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addModel();
  });
  $('btn-test-model').onclick = testModel;
  $('btn-launch-claude').onclick = launchCustomClaude;
  $('btn-launch-codex-custom').onclick = launchCustomCodex;

  // API 地址自动去掉 /v1 后缀（失焦时规范化为干净基址）
  $('custom-baseurl').addEventListener('blur', () => {
    const cleaned = stripV1($('custom-baseurl').value);
    if (cleaned !== $('custom-baseurl').value.trim()) {
      $('custom-baseurl').value = cleaned;
      setMsg('msg-custom', '已自动去掉 /v1 后缀（地址统一不带 /v1）', 'ok');
    }
  });

  // 点击模型chip选择
  $('custom-models').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-model]');
    if (chip) selectModel(chip.getAttribute('data-model'));
  });

  // ── 本地 9Router ──
  $('btn-launch-local').onclick = launchLocalWithVSCode;
  $('btn-router-only').onclick = toggleRouter;
  $('btn-scan-kiro').onclick = scanKiroCredential;
  $('btn-copy-local').onclick = async () => {
    const v = $('local-apikey').textContent;
    if (!v || v === '—') return;
    try {
      await navigator.clipboard.writeText(v);
      setMsg('msg-local', 'API Key 已复制', 'ok');
    } catch {
      setMsg('msg-local', '复制失败', 'err');
    }
  };
  $('btn-copy-lan').onclick = async () => {
    const v = $('local-lanurl').textContent;
    if (!v || v === '—') return;
    try {
      await navigator.clipboard.writeText(v);
      setMsg('msg-local', '局域网地址已复制', 'ok');
    } catch {
      setMsg('msg-local', '复制失败', 'err');
    }
  };
  $('btn-copy-refresh').onclick = async () => {
    const v = $('kiro-refresh-token').title;
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      setMsg('msg-local', 'RefreshToken 已复制', 'ok');
    } catch {
      setMsg('msg-local', '复制失败', 'err');
    }
  };
  $('local-baseurl').onclick = (e) => {
    e.preventDefault();
    openLocalUrl($('local-baseurl').textContent);
  };
  $('local-lanurl').onclick = (e) => {
    e.preventDefault();
    openLocalUrl($('local-lanurl').textContent);
  };

  // ── 日志框 ──
  $('btn-log-clear').onclick = () => {
    $('logbox').hidden = true;
    $('logbox-body').textContent = '';
    resetLaunchProgress();
  };

  // ── 密钥小眼睛切换 ──
  $('btn-toggle-key-vis').onclick = () => {
    const input = $('custom-apikey');
    const btn = $('btn-toggle-key-vis');
    if (input.type === 'password') {
      input.type = 'text';
      btn.classList.add('visible');
      btn.title = '隐藏密钥';
    } else {
      input.type = 'password';
      btn.classList.remove('visible');
      btn.title = '显示/隐藏密钥';
    }
  };

  // ── 接收主进程日志流 ──
  window.api.onLaunchLog((line) => appendLog(line));
  window.api.onLaunchProgress((payload) => updateLaunchProgress(payload));
}

// ============================================================
// 启动入口
// ============================================================

async function main() {
  bindEvents();
  initFingerprint();  // 后台采集，不阻塞
  loadMcpSettings();

  // 加载配置和密钥
  const cfg = await window.api.readConfig();
  store = await window.api.keysRead();

  renderKeyList();
  renderRightPanel();

  // 如果有选中的密钥，自动查询用量
  if (store.activeId) {
    const k = activeKey();
    if (k && !isManualKey(k)) {
      queryRemoteKey({ silent: true });
    }
  }
}

main();
