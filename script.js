"use strict";

/* ============ STATE ============ */
const state = {
  doc: null, selection: new Set(), viewport: { x: 0, y: 0, zoom: 1 },
  tool: 'select',
  defaultStyle: { fill: '#4ecdc4', stroke: '#2a2a2a', strokeWidth: 2, opacity: 1 },
  history: { undo: [], redo: [] },
  interaction: null, snapshotBefore: null,
  aspectLocked: false, magnetEnabled: true, snapGuides: null,
  pen: { active: false, nodeId: null, dragAnchorIndex: -1, mousePos: null, dragging: false },
  pathEditing: null, selectedAnchor: -1,
  clipboard: null, pasteCount: 0,
  dragging: false, draggingIds: null,
  editingPowerClip: null, _editingContentsIds: null,
  cropping: null,
};

let activePointerId = null, pointerAbort = null, marqueeRect = null;
let propSnapshot = null, propTimer = null, lastToolbarSig = '';
let contextMenuEl = null, fileMenuEl = null, renderPending = false;
let panelUpdateTimer = null, polygonClippingPromise = null, autosaveTimer = null;
let pinchState = null;
const touchPointers = new Map();

/* ============ CANVAS ============ */
const scene = document.getElementById('scene');
const ctx = scene.getContext('2d');
const overlay = document.getElementById('overlay');
const canvasArea = document.getElementById('canvasArea');
const floatingToolbar = document.getElementById('floatingToolbar');
const path2dCache = new Map();
const imageCache = new Map();
let hitCtx = null;
let cachedSceneRect = null;

function getHitCtx() {
  if (!hitCtx) { const c = document.createElement('canvas'); c.width = 1; c.height = 1; hitCtx = c.getContext('2d'); }
  return hitCtx;
}
function getImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  imageCache.set(src, img);
  img.onload = () => scheduleRender();
  return img;
}
function getSceneRect() {
  if (!cachedSceneRect) {
    cachedSceneRect = scene.getBoundingClientRect();
    requestAnimationFrame(() => { cachedSceneRect = null; });
  }
  return cachedSceneRect;
}
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function pathHash(node) {
  if (node.type !== 'path') return 0;
  const parts = [];
  for (const sp of getSubpaths(node)) {
    parts.push(sp.closed ? '1' : '0');
    for (const a of sp.anchors) parts.push(a.x.toFixed(2), a.y.toFixed(2), a.cIn.x.toFixed(2), a.cIn.y.toFixed(2), a.cOut.x.toFixed(2), a.cOut.y.toFixed(2));
  }
  return fnv1a(parts.join('|'));
}

/* ============ AUTOSAVE ============ */
const DB_NAME = 'vector-editor-db', STORE_NAME = 'autosave', AUTOSAVE_DELAY = 1500;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function autosaveDoc() {
  try {
    let docToSave = state.doc;
    if (state.editingPowerClip && state._editingContentsIds) {
      docToSave = JSON.parse(JSON.stringify(state.doc));
      const pcClone = findPC(docToSave.nodes, state.editingPowerClip);
      if (pcClone) {
        const contents = [], keep = [];
        for (const n of docToSave.nodes) (state._editingContentsIds.has(n.id) ? contents : keep).push(n);
        docToSave.nodes = keep;
        pcClone.contents = contents;
      }
    }
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ doc: docToSave, savedAt: Date.now() }, 'latest');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    updateAutosaveIndicator('saved');
  } catch (e) {
    console.warn('Autosave failed:', e);
    updateAutosaveIndicator('error');
  }
}
function findPC(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === 'group' && n.children) { const r = findPC(n.children, id); if (r) return r; }
  }
  return null;
}
async function loadAutosave() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get('latest');
    return new Promise((resolve) => { req.onsuccess = () => resolve(req.result || null); req.onerror = () => resolve(null); });
  } catch (e) { return null; }
}
async function clearAutosave() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('latest');
    await new Promise((res) => { tx.oncomplete = res; });
  } catch (e) {}
}
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  updateAutosaveIndicator('pending');
  autosaveTimer = setTimeout(() => { autosaveTimer = null; autosaveDoc(); }, AUTOSAVE_DELAY);
}
function updateAutosaveIndicator(status) {
  const dot = document.getElementById('autosaveDot');
  if (!dot) return;
  const map = {
    pending: ['#ffb800', 'Autosave: pending…'],
    saved: ['#4ecdc4', 'Autosave: saved ' + new Date().toLocaleTimeString()],
    error: ['#ff4444', 'Autosave: failed'],
    idle: ['#555', 'Autosave: idle'],
  };
  const [color, title] = map[status] || map.idle;
  dot.style.background = color;
  dot.title = title;
}

/* ============ RENDER BATCHING ============ */
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (document.hidden) return;
    render();
    renderOverlay();
  });
}
function schedulePanelUpdate() {
  if (panelUpdateTimer) return;
  panelUpdateTimer = setTimeout(() => { panelUpdateTimer = null; updatePropertiesPanel(); }, 80);
}
function ensurePolygonClipping() {
  if (typeof window.polygonClipping !== 'undefined') return Promise.resolve(window.polygonClipping);
  if (polygonClippingPromise) return polygonClippingPromise;
  polygonClippingPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/polygon-clipping@0.15.3/dist/polygon-clipping.umd.js';
    s.onload = () => resolve(window.polygonClipping);
    s.onerror = () => reject(new Error('Failed to load polygon-clipping'));
    document.head.appendChild(s);
  });
  return polygonClippingPromise;
}

/* ============ HELPERS ============ */
function genId() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
function getNodeName(n) { return n.type === 'powerclip' ? (n.name || 'PowerClip') : (n.name || capitalize(n.type)); }
function isTouchDevice() { return window.matchMedia && window.matchMedia('(pointer: coarse)').matches; }
function isSimpleNode(n) { return n.type !== 'group' && n.type !== 'powerclip'; }

function findNodeAndParent(id, nodes = state.doc.nodes, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, parent, list: nodes, index: i };
    if (n.type === 'group' && n.children) {
      const r = findNodeAndParent(id, n.children, n);
      if (r) return r;
    }
  }
  return null;
}
function getNode(id) { const info = findNodeAndParent(id); return info ? info.node : null; }
function getTopLevelAncestor(id) {
  function search(nodes, top) {
    for (const n of nodes) {
      if (n.id === id) return top || n;
      if (n.type === 'group' && n.children) {
        const r = search(n.children, top || n);
        if (r) return r;
      }
    }
    return null;
  }
  return search(state.doc.nodes, null);
}
function collectLeaves(node, result = []) {
  if (node.type === 'group') { for (const c of node.children) collectLeaves(c, result); }
  else if (node.type === 'powerclip') {
    if (node.container) collectLeaves(node.container, result);
    if (node.contents) for (const c of node.contents) collectLeaves(c, result);
  } else result.push(node);
  return result;
}
function isDescendant(ancestorId, nodeId) {
  if (ancestorId === nodeId) return true;
  const anc = getNode(ancestorId);
  if (!anc || anc.type !== 'group') return false;
  function walk(nodes) {
    for (const n of nodes) {
      if (n.id === nodeId) return true;
      if (n.type === 'group' && walk(n.children)) return true;
    }
    return false;
  }
  return walk(anc.children);
}
function eachPoint(node, fn) {
  if (node.subpaths) for (const sp of node.subpaths) for (const a of sp.anchors) fn(a);
  else if (node.anchors) for (const a of node.anchors) fn(a);
  if (node.type === 'group' && node.children) for (const c of node.children) eachPoint(c, fn);
  if (node.type === 'powerclip') {
    if (node.container) eachPoint(node.container, fn);
    if (node.contents) for (const c of node.contents) eachPoint(c, fn);
  }
}
function expandBounds(node) {
  if (node.type === 'path') return computePathBounds(node);
  if (node.type === 'powerclip') return node.container ? expandBounds(node.container) : { x:0, y:0, w:0, h:0 };
  if (node.type === 'text' && node.attachedPath) {
    return computePathBounds({ subpaths: node.attachedPath.subpaths });
  }
  if (node.type === 'group') {
    if (!node.children || !node.children.length) return { x:0, y:0, w:0, h:0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of node.children) {
      const b = expandBounds(c);
      const r = c.rotation || 0;
      if (r !== 0) {
        const cx = b.x + b.w/2, cy = b.y + b.h/2;
        const rad = r * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        for (const [px, py] of [[b.x, b.y], [b.x+b.w, b.y], [b.x, b.y+b.h], [b.x+b.w, b.y+b.h]]) {
          const dx = px-cx, dy = py-cy;
          const wx = cx + dx*cos - dy*sin, wy = cy + dx*sin + dy*cos;
          if (wx < minX) minX = wx; if (wy < minY) minY = wy;
          if (wx > maxX) maxX = wx; if (wy > maxY) maxY = wy;
        }
      } else {
        if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;
      }
    }
    return { x: minX, y: minY, w: maxX-minX, h: maxY-minY };
  }
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}
const getNodeBounds = expandBounds;

/* ============ GEOMETRY ============ */
function screenToWorld(sx, sy) {
  return { x: (sx - state.viewport.x) / state.viewport.zoom, y: (sy - state.viewport.y) / state.viewport.zoom };
}
function worldToScreen(wx, wy) {
  return { x: wx * state.viewport.zoom + state.viewport.x, y: wy * state.viewport.zoom + state.viewport.y };
}
function localToWorld(lx, ly, cx, cy, cos, sin) {
  const dx = lx - cx, dy = ly - cy;
  return { x: cx + dx*cos - dy*sin, y: cy + dx*sin + dy*cos };
}
function getHandleScreenPx() { return isTouchDevice() ? 4 : 2; }
function getHandleHitPx() { return isTouchDevice() ? 22 : 12; }
function roundedRectPath(x, y, w, h, corners) {
  const c = corners || {}, maxR = Math.min(w, h) / 2;
  const tl = Math.min(c.tl || 0, maxR), tr = Math.min(c.tr || 0, maxR);
  const br = Math.min(c.br || 0, maxR), bl = Math.min(c.bl || 0, maxR);
  return `M ${x+tl} ${y} L ${x+w-tr} ${y} ${tr ? `A ${tr} ${tr} 0 0 1 ${x+w} ${y+tr}` : ''} L ${x+w} ${y+h-br} ${br ? `A ${br} ${br} 0 0 1 ${x+w-br} ${y+h}` : ''} L ${x+bl} ${y+h} ${bl ? `A ${bl} ${bl} 0 0 1 ${x} ${y+h-bl}` : ''} L ${x} ${y+tl} ${tl ? `A ${tl} ${tl} 0 0 1 ${x+tl} ${y}` : ''} Z`;
}
function viewportMatrix() {
  return `translate(${state.viewport.x} ${state.viewport.y}) scale(${state.viewport.zoom})`;
}

/* ============ RULER & GUIDES ============ */
function drawRulers() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const zoom = state.viewport.zoom;

  function drawOne(canvas, axis) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
    }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, rect.width, rect.height);
    c.fillStyle = '#f8f8f8';
    c.fillRect(0, 0, rect.width, rect.height);
    c.strokeStyle = '#999';
    c.fillStyle = '#555';
    c.font = '9px system-ui';
    c.textBaseline = 'middle';

    let step = 100;
    if (zoom > 4) step = 10;
    else if (zoom > 2) step = 20;
    else if (zoom > 1) step = 50;
    else if (zoom > 0.5) step = 100;
    else if (zoom > 0.2) step = 200;
    else step = 500;

    if (axis === 'h') {
      const startW = -state.viewport.x / zoom;
      const endW = (rect.width - state.viewport.x) / zoom;
      const start = Math.ceil(startW / step) * step;
      for (let w = start; w <= endW; w += step) {
        const sx = w * zoom + state.viewport.x;
        if (sx < -20 || sx > rect.width + 20) continue;
        c.beginPath(); c.moveTo(sx, rect.height - 5); c.lineTo(sx, rect.height); c.stroke();
        for (let m = 1; m < 5; m++) {
          const msx = (w + step / 5 * m) * zoom + state.viewport.x;
          c.beginPath(); c.moveTo(msx, rect.height - 2); c.lineTo(msx, rect.height); c.stroke();
        }
        c.fillText(String(w), sx + 2, 8);
      }
    } else {
      const startW = -state.viewport.y / zoom;
      const endW = (rect.height - state.viewport.y) / zoom;
      const start = Math.ceil(startW / step) * step;
      for (let w = start; w <= endW; w += step) {
        const sy = w * zoom + state.viewport.y;
        if (sy < -20 || sy > rect.height + 20) continue;
        c.beginPath(); c.moveTo(rect.width - 5, sy); c.lineTo(rect.width, sy); c.stroke();
        for (let m = 1; m < 5; m++) {
          const msy = (w + step / 5 * m) * zoom + state.viewport.y;
          c.beginPath(); c.moveTo(rect.width - 2, msy); c.lineTo(rect.width, msy); c.stroke();
        }
        c.save();
        c.translate(8, sy + 2);
        c.rotate(-Math.PI / 2);
        c.fillText(String(w), 0, 0);
        c.restore();
      }
    }

    for (const g of (state.doc.guides || [])) {
      if (axis === 'h' && g.axis === 'v') {
        const sx = g.pos * zoom + state.viewport.x;
        if (sx >= 0 && sx <= rect.width) { c.fillStyle = '#0af'; c.fillRect(sx - 1, 0, 2, rect.height); }
      } else if (axis === 'v' && g.axis === 'h') {
        const sy = g.pos * zoom + state.viewport.y;
        if (sy >= 0 && sy <= rect.height) { c.fillStyle = '#0af'; c.fillRect(0, sy - 1, rect.width, 2); }
      }
    }
  }

  drawOne(document.getElementById('rulerHCanvas'), 'h');
  drawOne(document.getElementById('rulerVCanvas'), 'v');
}

function addGuide(axis, pos) {
  commitChange(() => {
    if (!state.doc.guides) state.doc.guides = [];
    state.doc.guides.push({ id: genId(), axis, pos });
  });
  scheduleRender();
}
function removeGuide(id) {
  commitChange(() => {
    state.doc.guides = (state.doc.guides || []).filter(g => g.id !== id);
  });
  scheduleRender();
}
function bindRulers() {
  const rulerH = document.getElementById('rulerH');
  const rulerV = document.getElementById('rulerV');

  rulerH.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const rect = getSceneRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    beginInteraction();
    state.interaction = { type: 'guide-create', axis: 'h' };
    attachPointerHandlers(e.pointerId);
  });

  rulerV.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const rect = getSceneRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    beginInteraction();
    state.interaction = { type: 'guide-create', axis: 'v' };
    attachPointerHandlers(e.pointerId);
  });
}

/* ============ BEZIER ============ */
function cubicBezierPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t, mt2 = mt*mt, t2 = t*t;
  return {
    x: mt2*mt*p0.x + 3*mt2*t*p1.x + 3*mt*t2*p2.x + t2*t*p3.x,
    y: mt2*mt*p0.y + 3*mt2*t*p1.y + 3*mt*t2*p2.y + t2*t*p3.y,
  };
}
function lerp2(p, q, t) { return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }; }

/* ============ SUBPATHS ============ */
function ensureSubpaths(node) {
  if (!node.subpaths) {
    if (node.anchors) node.subpaths = [{ anchors: node.anchors, closed: !!node.closed }];
    else node.subpaths = [];
  }
  return node.subpaths;
}
function getSubpaths(node) { return ensureSubpaths(node); }

function anchorsToPathD(anchors, closed) {
  if (!anchors || anchors.length === 0) return '';
  if (anchors.length === 1) return `M ${anchors[0].x} ${anchors[0].y}`;
  let d = `M ${anchors[0].x} ${anchors[0].y}`;
  for (let i = 1; i < anchors.length; i++) {
    const p = anchors[i-1], c = anchors[i];
    d += ` C ${p.x+p.cOut.x} ${p.y+p.cOut.y} ${c.x+c.cIn.x} ${c.y+c.cIn.y} ${c.x} ${c.y}`;
  }
  if (closed) {
    const f = anchors[0], l = anchors[anchors.length-1];
    d += ` C ${l.x+l.cOut.x} ${l.y+l.cOut.y} ${f.x+f.cIn.x} ${f.y+f.cIn.y} ${f.x} ${f.y} Z`;
  }
  return d;
}
function getPathD(node) {
  return getSubpaths(node).map(sp => anchorsToPathD(sp.anchors, sp.closed)).filter(Boolean).join(' ');
}
function computePathBounds(node) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of getSubpaths(node)) {
    for (const a of sp.anchors) {
      const pts = [a, { x: a.x+a.cIn.x, y: a.y+a.cIn.y }, { x: a.x+a.cOut.x, y: a.y+a.cOut.y }];
      for (const p of pts) {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      }
    }
  }
  if (minX === Infinity) return { x:0, y:0, w:0, h:0 };
  return { x: minX, y: minY, w: maxX-minX, h: maxY-minY };
}
function syncPathBounds(node) {
  if (node.type !== 'path') return;
  const b = computePathBounds(node);
  node.x = b.x; node.y = b.y; node.w = b.w; node.h = b.h;
}
function makeAnchor(x, y, opts) {
  return { x, y, cIn: { x: opts?.cInX || 0, y: opts?.cInY || 0 }, cOut: { x: opts?.cOutX || 0, y: opts?.cOutY || 0 } };
}
function convertNodeToPath(nodeId) {
  const node = getNode(nodeId);
  if (!node || node.type === 'path') return;
  commitChange(() => {
    if (node.type === 'rect') {
      node.subpaths = [{ anchors: [
        makeAnchor(node.x, node.y), makeAnchor(node.x + node.w, node.y),
        makeAnchor(node.x + node.w, node.y + node.h), makeAnchor(node.x, node.y + node.h),
      ], closed: true }];
      node.type = 'path'; delete node.corners;
    } else if (node.type === 'ellipse') {
      const cx = node.x + node.w/2, cy = node.y + node.h/2;
      const rx = node.w/2, ry = node.h/2, k = 0.5522847498;
      node.subpaths = [{ anchors: [
        makeAnchor(cx, node.y, { cInX: -rx*k, cOutX: rx*k }),
        makeAnchor(node.x + node.w, cy, { cInY: -ry*k, cOutY: ry*k }),
        makeAnchor(cx, node.y + node.h, { cInX: rx*k, cOutX: -rx*k }),
        makeAnchor(node.x, cy, { cInY: ry*k, cOutY: -ry*k }),
      ], closed: true }];
      node.type = 'path';
    } else if (node.type === 'line') {
      node.subpaths = [{ anchors: [makeAnchor(node.x, node.y), makeAnchor(node.x + node.w, node.y + node.h)], closed: false }];
      node.type = 'path';
      if (!node.style) node.style = {};
      node.style.fill = 'none';
    } else return;
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('Converted to path');
}

/* ============ COLOR / GRADIENT ============ */
function normalizeHex(h) {
  if (!h) return '#000000';
  h = String(h).trim();
  if (!h.startsWith('#')) h = '#' + h;
  if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return '#000000';
  return h.toLowerCase();
}
function isGradientFill(f) { return f && typeof f === 'object' && Array.isArray(f.stops); }
function invertColor(hex) {
  hex = normalizeHex(hex);
  const r = 255 - parseInt(hex.slice(1,3), 16);
  const g = 255 - parseInt(hex.slice(3,5), 16);
  const b = 255 - parseInt(hex.slice(5,7), 16);
  return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
}
function getFillCss(style, nodeId) {
  const f = style?.fill;
  if (!f) return 'none';
  if (typeof f === 'string') return f;
  if (isGradientFill(f)) return `url(#grad-${nodeId})`;
  return 'none';
}
function buildGradientDef(node) {
  const fill = node.style?.fill;
  if (!isGradientFill(fill)) return '';
  const gid = `grad-${node.id}`;
  const stops = [...fill.stops].sort((a,b) => a.offset - b.offset)
    .map(s => `<stop offset="${Math.round(s.offset*100)}%" stop-color="${s.color}"/>`).join('');
  if (fill.type === 'radial') return `<radialGradient id="${gid}" cx="50%" cy="50%" r="50%">${stops}</radialGradient>`;
  const rad = ((fill.angle || 0) - 90) * Math.PI / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  return `<linearGradient id="${gid}" x1="${(0.5 - dx*0.5)*100}%" y1="${(0.5 - dy*0.5)*100}%" x2="${(0.5 + dx*0.5)*100}%" y2="${(0.5 + dy*0.5)*100}%">${stops}</linearGradient>`;
}
function buildCanvasFillStyle(ctx2d, n) {
  const f = n.style?.fill;
  if (!f) return null;
  if (typeof f === 'string') return f === 'none' ? null : f;
  if (!isGradientFill(f)) return null;
  const cx = n.x + n.w/2, cy = n.y + n.h/2;
  let grad;
  if (f.type === 'radial') {
    const r = Math.max(n.w, n.h) / 2;
    grad = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r, 0.01));
  } else {
    const rad = ((f.angle || 0) - 90) * Math.PI / 180;
    const dx = Math.cos(rad), dy = Math.sin(rad), len = Math.max(n.w, n.h) || 1;
    grad = ctx2d.createLinearGradient(cx - dx*len/2, cy - dy*len/2, cx + dx*len/2, cy + dy*len/2);
  }
  for (const s of f.stops) grad.addColorStop(Math.max(0, Math.min(1, s.offset)), s.color);
  return grad;
}
function schedulePropCommit() {
  clearTimeout(propTimer);
  propTimer = setTimeout(() => {
    if (propSnapshot !== null && propSnapshot !== JSON.stringify(state.doc)) {
      state.history.undo.push(propSnapshot);
      state.history.redo = [];
      updateHistoryButtons();
      scheduleAutosave();
    }
    propSnapshot = null;
  }, 400);
}

/* ============ SNAP ============ */
function findSnap(val, targets, threshold) {
  let best = null, bestDist = threshold;
  for (const t of targets) { const d = Math.abs(val - t); if (d < bestDist) { bestDist = d; best = t; } }
  return best;
}
function computeSnapForBounds(b, excludeIds, threshold) {
  const xTargets = [0, state.doc.canvasW, state.doc.canvasW / 2];
  const yTargets = [0, state.doc.canvasH, state.doc.canvasH / 2];
  // Guide targets
  for (const g of (state.doc.guides || [])) {
    if (g.axis === 'v') xTargets.push(g.pos);
    else yTargets.push(g.pos);
  }
  const pad = 200 / state.viewport.zoom;
  for (const n of state.doc.nodes) {
    if (excludeIds.has(n.id)) continue;
    const nb = getNodeBounds(n);
    if (nb.x + nb.w < b.x - pad || nb.x > b.x + b.w + pad) continue;
    if (nb.y + nb.h < b.y - pad || nb.y > b.y + b.h + pad) continue;
    xTargets.push(nb.x, nb.x + nb.w, nb.x + nb.w / 2);
    yTargets.push(nb.y, nb.y + nb.h, nb.y + nb.h / 2);
  }
  const moveX = [b.x, b.x + b.w, b.x + b.w / 2];
  const moveY = [b.y, b.y + b.h, b.y + b.h / 2];
  let snapDx = 0, snapDy = 0, bestDistX = threshold, bestDistY = threshold;
  let guideX = null, guideY = null;
  for (const e of moveX) for (const t of xTargets) {
    const d = t - e;
    if (Math.abs(d) < bestDistX) { bestDistX = Math.abs(d); snapDx = d; guideX = t; }
  }
  for (const e of moveY) for (const t of yTargets) {
    const d = t - e;
    if (Math.abs(d) < bestDistY) { bestDistY = Math.abs(d); snapDy = d; guideY = t; }
  }
  return { dx: snapDx, dy: snapDy, guideX, guideY };
}

/* ============ EFFECTS ============ */
function hasEffects(node) {
  const fx = node.effects;
  return fx && ((fx.shadow && fx.shadow.on) || (fx.blur && fx.blur.on));
}
function buildFilterDef(node) {
  const fx = node.effects;
  if (!fx) return '';
  const shadow = fx.shadow?.on, blur = fx.blur?.on;
  if (!shadow && !blur) return '';
  const fid = `fx-${node.id}`, parts = [];
  let input = 'SourceGraphic';
  if (blur) {
    parts.push(`<feGaussianBlur in="${input}" stdDeviation="${fx.blur.radius || 4}" result="blurred"/>`);
    input = 'blurred';
  }
  if (shadow) {
    const s = fx.shadow;
    const col = (s.color || '#000000') + (s.color && s.color.length === 9 ? '' : 'AA');
    parts.push(`<feDropShadow in="${input}" dx="${s.x || 0}" dy="${s.y || 0}" stdDeviation="${(s.blur || 0) / 2}" flood-color="${col}"/>`);
  }
  return `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%">${parts.join('')}</filter>`;
}

/* ============ MULTILINE TEXT + TEXT ON PATH ============ */
function wrapLines(ctx2d, text, maxWidth) {
  const out = [];
  const paragraphs = String(text || '').split('\n');
  for (const p of paragraphs) {
    if (!p) { out.push(''); continue; }
    const words = p.split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      const test = cur + w;
      if (ctx2d.measureText(test).width > maxWidth && cur.trim()) {
        out.push(cur);
        cur = w.replace(/^\s+/, '');
      } else cur = test;
    }
    if (cur) out.push(cur);
  }
  return out;
}
function drawTextLines(ctx2d, n) {
  const fs = n.fontSize || 32;
  const lh = (n.lineHeight || 1.2) * fs;
  ctx2d.font = `${fs}px system-ui, sans-serif`;
  ctx2d.textBaseline = 'alphabetic';
  const fill = buildCanvasFillStyle(ctx2d, n);
  const stroke = n.style?.stroke, sw = n.style?.strokeWidth || 0;
  let lines, useWidth = false, align = n.align || 'left';
  if (n.textBox && n.w > 0) { lines = wrapLines(ctx2d, n.text || '', n.w); useWidth = true; }
  else lines = (n.text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineY = n.y + fs + i * lh;
    if (useWidth && lineY - fs > n.y + n.h) break;
    const line = lines[i];
    let tx = n.x;
    if (useWidth && (align === 'center' || align === 'right')) {
      const w = ctx2d.measureText(line).width;
      if (align === 'center') tx = n.x + (n.w - w) / 2;
      else tx = n.x + n.w - w;
    }
    if (fill) { ctx2d.fillStyle = fill; ctx2d.fillText(line, tx, lineY); }
    if (stroke && sw > 0) { ctx2d.strokeStyle = stroke; ctx2d.lineWidth = sw; ctx2d.strokeText(line, tx, lineY); }
  }
}
function buildPathSamples(subpaths) {
  const samples = [];
  let total = 0, prev = null;
  for (const sp of subpaths) {
    const anchors = sp.anchors;
    if (anchors.length < 2) continue;
    const segCount = sp.closed ? anchors.length : anchors.length - 1;
    for (let i = 0; i < segCount; i++) {
      const a = anchors[i], b = anchors[(i + 1) % anchors.length];
      const N = Math.max(10, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
      for (let s = (i === 0 ? 0 : 1); s <= N; s++) {
        const t = s / N;
        const p = cubicBezierPoint(
          { x: a.x, y: a.y }, { x: a.x + a.cOut.x, y: a.y + a.cOut.y },
          { x: b.x + b.cIn.x, y: b.y + b.cIn.y }, { x: b.x, y: b.y }, t);
        if (prev) total += Math.hypot(p.x - prev.x, p.y - prev.y);
        samples.push({ p, d: total });
        prev = p;
      }
    }
  }
  return { samples, total };
}
function drawTextOnPath(ctx2d, n) {
  if (!n.attachedPath || !n.attachedPath.subpaths) return;
  const { samples, total } = buildPathSamples(n.attachedPath.subpaths);
  if (!samples.length || total < 1) return;
  const fs = n.fontSize || 32;
  ctx2d.font = `${fs}px system-ui, sans-serif`;
  ctx2d.textBaseline = 'middle';
  ctx2d.textAlign = 'left';
  const fill = buildCanvasFillStyle(ctx2d, n);
  if (!fill) return;
  ctx2d.fillStyle = fill;
  const text = n.text || '';
  const offset = (n.pathStartOffset || 0) * total;
  let dist = offset, si = 0;
  for (const ch of text) {
    if (ch === '\n') continue;
    const w = ctx2d.measureText(ch).width;
    if (dist + w > total) break;
    while (si < samples.length - 1 && samples[si + 1].d < dist) si++;
    const s0 = samples[si], s1 = samples[Math.min(si + 1, samples.length - 1)];
    const segLen = s1.d - s0.d;
    const t = segLen > 0.0001 ? (dist - s0.d) / segLen : 0;
    const x = s0.p.x + (s1.p.x - s0.p.x) * t;
    const y = s0.p.y + (s1.p.y - s0.p.y) * t;
    const angle = Math.atan2(s1.p.y - s0.p.y, s1.p.x - s0.p.x);
    ctx2d.save();
    ctx2d.translate(x, y);
    ctx2d.rotate(angle);
    ctx2d.fillText(ch, 0, 0);
    ctx2d.restore();
    dist += w;
  }
}
function attachTextToPath() {
  const sel = [...state.selection].map(getNode).filter(Boolean);
  const text = sel.find(n => n.type === 'text');
  const path = sel.find(n => n.type === 'path');
  if (!text || !path) { showToast('Select text + path'); return; }
  commitChange(() => {
    text.attachedPath = { subpaths: JSON.parse(JSON.stringify(path.subpaths)) };
    const info = findNodeAndParent(path.id);
    if (info) info.list.splice(info.index, 1);
    state.selection = new Set([text.id]);
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('✓ Text attached to path');
}
function detachTextFromPath() {
  const sel = [...state.selection].map(getNode).filter(n => n && n.attachedPath);
  if (!sel.length) return;
  commitChange(() => { for (const n of sel) delete n.attachedPath; });
  scheduleRender(); updatePropertiesPanel();
  showToast('✓ Text detached');
}

/* ============ CROP ============ */
function enterCropMode(nodeId) {
  const n = getNode(nodeId);
  if (!n || n.type !== 'image') return;
  const img = getImage(n.src);
  if (!img.complete || !img.naturalWidth) { showToast('Image not ready'); return; }
  const crop = n.crop || { x: 0, y: 0, w: 1, h: 1 };
  const fullW = n.w / crop.w, fullH = n.h / crop.h;
  const fullX = n.x - crop.x * fullW, fullY = n.y - crop.y * fullH;
  state.cropping = {
    nodeId,
    origCrop: { ...crop },
    origBounds: { x: n.x, y: n.y, w: n.w, h: n.h },
    fullBounds: { x: fullX, y: fullY, w: fullW, h: fullH },
    cropRect: { x: n.x, y: n.y, w: n.w, h: n.h },
  };
  scheduleRender();
  showToast('Crop mode — drag handles, ✓ to apply');
}
function applyCrop() {
  const c = state.cropping;
  if (!c) return;
  const n = getNode(c.nodeId);
  if (!n) { state.cropping = null; scheduleRender(); return; }
  commitChange(() => {
    n.crop = {
      x: (c.cropRect.x - c.fullBounds.x) / c.fullBounds.w,
      y: (c.cropRect.y - c.fullBounds.y) / c.fullBounds.h,
      w: c.cropRect.w / c.fullBounds.w,
      h: c.cropRect.h / c.fullBounds.h,
    };
    n.x = c.cropRect.x; n.y = c.cropRect.y; n.w = c.cropRect.w; n.h = c.cropRect.h;
  });
  state.cropping = null;
  scheduleRender(); updatePropertiesPanel();
  showToast('✓ Image cropped');
}
function cancelCrop() { state.cropping = null; scheduleRender(); }
function drawCroppingPreview(ctx2d, n) {
  const c = state.cropping;
  const fb = c.fullBounds;
  const img = getImage(n.src);
  if (img.complete && img.naturalWidth > 0) ctx2d.drawImage(img, fb.x, fb.y, fb.w, fb.h);
  else { ctx2d.fillStyle = '#eee'; ctx2d.fillRect(fb.x, fb.y, fb.w, fb.h); }
  ctx2d.save();
  ctx2d.fillStyle = 'rgba(0,0,0,0.55)';
  ctx2d.beginPath();
  ctx2d.rect(fb.x, fb.y, fb.w, fb.h);
  ctx2d.rect(c.cropRect.x, c.cropRect.y, c.cropRect.w, c.cropRect.h);
  ctx2d.fill('evenodd');
  ctx2d.restore();
}

/* ============ POWERCLIP ============ */
function createPowerClip() {
  const selIds = [...state.selection];
  if (selIds.length < 2) { showToast('Select 2+ objects'); return; }
  const topIds = [];
  for (const id of selIds) {
    const top = getTopLevelAncestor(id);
    if (top && !topIds.find(t => t.id === top.id)) topIds.push(top);
  }
  if (topIds.length < 2) { showToast('Need 2+ top-level objects'); return; }
  let containerId = topIds[0].id, maxIdx = -1;
  for (const t of topIds) {
    const idx = state.doc.nodes.findIndex(n => n.id === t.id);
    if (idx > maxIdx) { maxIdx = idx; containerId = t.id; }
  }
  commitChange(() => {
    const contents = [];
    let containerNode = null;
    for (const t of topIds) {
      const info = findNodeAndParent(t.id);
      if (!info) continue;
      (t.id === containerId ? (containerNode = info.node) : contents.push(info.node));
      info.list.splice(info.index, 1);
    }
    if (!containerNode || !contents.length) return;
    const b = getNodeBounds(containerNode);
    const pc = { id: genId(), type: 'powerclip', name: 'PowerClip',
      x: b.x, y: b.y, w: b.w, h: b.h, rotation: 0, container: containerNode, contents };
    state.doc.nodes.push(pc);
    state.selection = new Set([pc.id]);
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('✓ PowerClip created');
}
function enterPowerClipEdit(pcId) {
  const pc = getNode(pcId);
  if (!pc || pc.type !== 'powerclip') return;
  if (state.editingPowerClip) exitPowerClipEdit();
  state.editingPowerClip = pcId;
  state._editingContentsIds = new Set((pc.contents || []).map(c => c.id));
  const info = findNodeAndParent(pcId);
  if (!info) { state.editingPowerClip = null; state._editingContentsIds = null; return; }
  const contents = (pc.contents || []).splice(0);
  state.doc.nodes.splice(info.index + 1, 0, ...contents);
  state.selection = new Set(contents.map(c => c.id));
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('✏️ Editing PowerClip');
}
function exitPowerClipEdit() {
  const pcId = state.editingPowerClip;
  if (!pcId) return;
  const pc = getNode(pcId), editingIds = state._editingContentsIds;
  state.editingPowerClip = null;
  state._editingContentsIds = null;
  if (!pc || pc.type !== 'powerclip') { scheduleRender(); return; }
  commitChange(() => {
    const contents = [];
    for (const id of (editingIds || [])) {
      const info = findNodeAndParent(id);
      if (info && info.list === state.doc.nodes) { contents.push(info.node); info.list.splice(info.index, 1); }
    }
    pc.contents = contents;
  });
  state.selection = new Set([pcId]);
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('✓ PowerClip updated');
}
function extractPowerClip() {
  const sel = [...state.selection].map(getNode).filter(n => n && n.type === 'powerclip');
  if (!sel.length) return;
  if (state.editingPowerClip) exitPowerClipEdit();
  commitChange(() => {
    const newIds = [];
    for (const pc of sel) {
      const info = findNodeAndParent(pc.id);
      if (!info) continue;
      info.list.splice(info.index, 1);
      const toInsert = [];
      if (pc.container) toInsert.push(pc.container);
      for (const c of (pc.contents || [])) toInsert.push(c);
      info.list.splice(info.index, 0, ...toInsert);
      for (const n of toInsert) newIds.push(n.id);
    }
    state.selection = new Set(newIds);
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('✓ Contents extracted');
}
function scaleFromSnapshot(live, orig, pcOrig, nx, ny, nw, nh) {
  const sx = pcOrig.w > 0 ? nw / pcOrig.w : 1;
  const sy = pcOrig.h > 0 ? nh / pcOrig.h : 1;
  live.x = nx + (orig.x - pcOrig.x) * sx;
  live.y = ny + (orig.y - pcOrig.y) * sy;
  live.w = orig.w * sx; live.h = orig.h * sy;
  if (live.subpaths && orig.subpaths) {
    for (let si = 0; si < live.subpaths.length; si++)
      for (let ai = 0; ai < live.subpaths[si].anchors.length; ai++) {
        const a = live.subpaths[si].anchors[ai], oa = orig.subpaths[si].anchors[ai];
        if (!oa) continue;
        a.x = nx + (oa.x - pcOrig.x) * sx; a.y = ny + (oa.y - pcOrig.y) * sy;
        a.cIn.x = oa.cIn.x * sx; a.cIn.y = oa.cIn.y * sy;
        a.cOut.x = oa.cOut.x * sx; a.cOut.y = oa.cOut.y * sy;
      }
  }
  if (live.type === 'group' && orig.children)
    for (let i = 0; i < live.children.length; i++)
      scaleFromSnapshot(live.children[i], orig.children[i], pcOrig, nx, ny, nw, nh);
  if (live.type === 'powerclip') {
    if (live.container && orig.container) scaleFromSnapshot(live.container, orig.container, pcOrig, nx, ny, nw, nh);
    if (live.contents && orig.contents)
      for (let i = 0; i < live.contents.length; i++)
        scaleFromSnapshot(live.contents[i], orig.contents[i], pcOrig, nx, ny, nw, nh);
  }
}

/* ============ CANVAS RENDER ============ */
function applyNodeStyle(ctx2d, n) {
  const isDragged = state.dragging && state.draggingIds && state.draggingIds.has(n.id);
  const op = n.style?.opacity !== undefined ? n.style.opacity : 1;
  if (hasEffects(n) && !isDragged) {
    const fx = n.effects;
    if (fx.shadow?.on) {
      ctx2d.shadowColor = fx.shadow.color || '#000000';
      ctx2d.shadowBlur = (fx.shadow.blur || 0) / 2;
      ctx2d.shadowOffsetX = fx.shadow.x || 0;
      ctx2d.shadowOffsetY = fx.shadow.y || 0;
    }
    if (fx.blur?.on) { try { ctx2d.filter = `blur(${fx.blur.radius || 4}px)`; } catch {} }
  }
  ctx2d.globalAlpha = op;
}
function resetCtxStyle(ctx2d) {
  ctx2d.shadowColor = 'transparent'; ctx2d.shadowBlur = 0;
  ctx2d.shadowOffsetX = 0; ctx2d.shadowOffsetY = 0;
  try { ctx2d.filter = 'none'; } catch {}
  ctx2d.globalAlpha = 1;
}
function getPath2D(n) {
  const hash = pathHash(n);
  const cached = path2dCache.get(n.id);
  if (cached && cached.hash === hash) return cached.path;
  const p = new Path2D();
  for (const sp of getSubpaths(n)) {
    const anchors = sp.anchors;
    if (anchors.length < 2) continue;
    p.moveTo(anchors[0].x, anchors[0].y);
    for (let i = 1; i < anchors.length; i++) {
      const prev = anchors[i-1], cur = anchors[i];
      p.bezierCurveTo(prev.x+prev.cOut.x, prev.y+prev.cOut.y, cur.x+cur.cIn.x, cur.y+cur.cIn.y, cur.x, cur.y);
    }
    if (sp.closed) {
      const first = anchors[0], last = anchors[anchors.length-1];
      p.bezierCurveTo(last.x+last.cOut.x, last.y+last.cOut.y, first.x+first.cIn.x, first.y+first.cIn.y, first.x, first.y);
      p.closePath();
    }
  }
  path2dCache.set(n.id, { path: p, hash });
  return p;
}
function buildNodePath(ctx2d, node) {
  if (node.type === 'rect') {
    const c = node.corners || { tl:0, tr:0, br:0, bl:0 };
    const x = node.x, y = node.y, w = Math.abs(node.w), h = Math.abs(node.h);
    if (c.tl || c.tr || c.br || c.bl) {
      const maxR = Math.min(w, h) / 2;
      const tl = Math.min(c.tl||0, maxR), tr = Math.min(c.tr||0, maxR);
      const br = Math.min(c.br||0, maxR), bl = Math.min(c.bl||0, maxR);
      ctx2d.moveTo(x+tl, y); ctx2d.lineTo(x+w-tr, y);
      if (tr) ctx2d.arcTo(x+w, y, x+w, y+tr, tr);
      ctx2d.lineTo(x+w, y+h-br);
      if (br) ctx2d.arcTo(x+w, y+h, x+w-br, y+h, br);
      ctx2d.lineTo(x+bl, y+h);
      if (bl) ctx2d.arcTo(x, y+h, x, y+h-bl, bl);
      ctx2d.lineTo(x, y+tl);
      if (tl) ctx2d.arcTo(x, y, x+tl, y, tl);
      ctx2d.closePath();
    } else ctx2d.rect(x, y, w, h);
  } else if (node.type === 'ellipse') {
    ctx2d.ellipse(node.x + node.w/2, node.y + node.h/2, Math.abs(node.w)/2, Math.abs(node.h)/2, 0, 0, Math.PI*2);
  } else if (node.type === 'path') {
    ctx2d.addPath(getPath2D(node));
  } else if (node.type === 'group') {
    const b = getNodeBounds(node);
    ctx2d.rect(b.x, b.y, b.w, b.h);
  } else {
    ctx2d.rect(node.x, node.y, Math.abs(node.w), Math.abs(node.h));
  }
}
function paintPath(ctx2d, n, pathObj) {
  const fill = buildCanvasFillStyle(ctx2d, n);
  const stroke = n.style?.stroke, sw = n.style?.strokeWidth || 0;
  const hasClosed = getSubpaths(n).some(sp => sp.closed);
  if (hasClosed && fill) {
    ctx2d.fillStyle = fill;
    if (n.fillRule) ctx2d.fill(pathObj, n.fillRule);
    else ctx2d.fill(pathObj);
  }
  if (stroke && sw > 0) {
    ctx2d.strokeStyle = stroke;
    ctx2d.lineWidth = sw;
    ctx2d.lineJoin = 'round';
    ctx2d.stroke(pathObj);
  }
}
function drawPowerClip(ctx2d, n) {
  const container = n.container;
  if (!container) return;
  if (state.editingPowerClip === n.id) {
    const b = getNodeBounds(container);
    ctx2d.save();
    ctx2d.strokeStyle = '#ff8800';
    ctx2d.lineWidth = 2 / state.viewport.zoom;
    ctx2d.setLineDash([8/state.viewport.zoom, 6/state.viewport.zoom]);
    ctx2d.strokeRect(b.x, b.y, b.w, b.h);
    ctx2d.restore();
    return;
  }
  const cx = n.x + n.w/2, cy = n.y + n.h/2;
  const rot = (n.rotation || 0) * Math.PI / 180;
  ctx2d.save();
  if (rot !== 0) { ctx2d.translate(cx, cy); ctx2d.rotate(rot); ctx2d.translate(-cx, -cy); }
  ctx2d.beginPath();
  buildNodePath(ctx2d, container);
  ctx2d.clip();
  for (const c of (n.contents || [])) drawNode(ctx2d, c);
  ctx2d.restore();
  const sw = container.style?.strokeWidth || 0;
  if (sw > 0 && container.style?.stroke && container.style?.stroke !== 'none') {
    ctx2d.save();
    if (rot !== 0) { ctx2d.translate(cx, cy); ctx2d.rotate(rot); ctx2d.translate(-cx, -cy); }
    ctx2d.beginPath();
    buildNodePath(ctx2d, container);
    ctx2d.strokeStyle = container.style.stroke;
    ctx2d.lineWidth = sw;
    ctx2d.stroke();
    ctx2d.restore();
  }
}
function drawNode(ctx2d, n) {
  if (n.type === 'group') { for (const c of n.children) drawNode(ctx2d, c); return; }
  if (n.type === 'powerclip') { drawPowerClip(ctx2d, n); return; }
  const cx = n.x + n.w/2, cy = n.y + n.h/2;
  const rot = (n.rotation || 0) * Math.PI / 180;
  ctx2d.save();
  if (rot !== 0) { ctx2d.translate(cx, cy); ctx2d.rotate(rot); ctx2d.translate(-cx, -cy); }
  applyNodeStyle(ctx2d, n);
  const fillStyle = buildCanvasFillStyle(ctx2d, n);
  const stroke = n.style?.stroke, sw = n.style?.strokeWidth || 0;

  if (n.type === 'rect' || n.type === 'ellipse') {
    ctx2d.beginPath();
    if (n.type === 'rect') buildNodePath(ctx2d, n);
    else ctx2d.ellipse(cx, cy, Math.abs(n.w)/2, Math.abs(n.h)/2, 0, 0, Math.PI*2);
    if (fillStyle) { ctx2d.fillStyle = fillStyle; ctx2d.fill(); }
    if (stroke && sw > 0) { ctx2d.strokeStyle = stroke; ctx2d.lineWidth = sw; ctx2d.stroke(); }
  } else if (n.type === 'line') {
    ctx2d.beginPath();
    ctx2d.moveTo(n.x, n.y);
    ctx2d.lineTo(n.x + n.w, n.y + n.h);
    ctx2d.strokeStyle = stroke || '#2a2a2a';
    ctx2d.lineWidth = sw || 2;
    ctx2d.lineCap = 'round';
    ctx2d.stroke();
  } else if (n.type === 'text') {
    if (n.attachedPath) drawTextOnPath(ctx2d, n);
    else drawTextLines(ctx2d, n);
  } else if (n.type === 'image') {
    if (state.cropping && state.cropping.nodeId === n.id) {
      drawCroppingPreview(ctx2d, n);
    } else {
      const img = getImage(n.src);
      if (img.complete && img.naturalWidth > 0) {
        const crop = n.crop || { x: 0, y: 0, w: 1, h: 1 };
        const iw = img.naturalWidth, ih = img.naturalHeight;
        ctx2d.drawImage(img,
          iw * crop.x, ih * crop.y, iw * crop.w, ih * crop.h,
          n.x, n.y, Math.abs(n.w), Math.abs(n.h));
      } else {
        ctx2d.fillStyle = '#eee';
        ctx2d.fillRect(n.x, n.y, Math.abs(n.w), Math.abs(n.h));
      }
    }
  } else if (n.type === 'path') {
    paintPath(ctx2d, n, getPath2D(n));
  }
  resetCtxStyle(ctx2d);
  ctx2d.restore();
}

function render() {
  const rect = canvasArea.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const sceneRect = scene.getBoundingClientRect();
  const w = Math.floor(sceneRect.width * dpr), h = Math.floor(sceneRect.height * dpr);
  if (scene.width !== w || scene.height !== h) {
    scene.width = w; scene.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, sceneRect.width, sceneRect.height);
  ctx.save();
  ctx.translate(state.viewport.x, state.viewport.y);
  ctx.scale(state.viewport.zoom, state.viewport.zoom);
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, state.doc.canvasW, state.doc.canvasH);
  ctx.strokeStyle = '#bbb';
  ctx.lineWidth = 1 / state.viewport.zoom;
  ctx.strokeRect(0, 0, state.doc.canvasW, state.doc.canvasH);
  for (const n of state.doc.nodes) drawNode(ctx, n);
  ctx.restore();
  drawRulers();
}

/* ============ HIT TESTING ============ */
function hitTest(wx, wy) {
  for (let i = state.doc.nodes.length - 1; i >= 0; i--) {
    const id = hitTestNode(state.doc.nodes[i], wx, wy);
    if (id) return id;
  }
  return null;
}
function hitTestNode(n, wx, wy) {
  if (n.type === 'group') {
    for (const c of n.children) if (hitTestNode(c, wx, wy)) return n.id;
    return null;
  }
  if (n.type === 'powerclip') {
    if (state.editingPowerClip === n.id) return null;
    return (n.container && hitTestNode(n.container, wx, wy)) ? n.id : null;
  }
  if (n.type === 'text' && n.attachedPath) {
    const b = computePathBounds({ subpaths: n.attachedPath.subpaths });
    if (wx < b.x - 30 || wx > b.x + b.w + 30) return null;
    if (wy < b.y - 40 || wy > b.y + b.h + 40) return null;
    return n.id;
  }
  const b = getNodeBounds(n);
  if (wx < b.x - 4 || wx > b.x + b.w + 4) return null;
  if (wy < b.y - 4 || wy > b.y + b.h + 4) return null;
  const cx = n.x + n.w/2, cy = n.y + n.h/2;
  const rot = (n.rotation || 0) * Math.PI / 180;
  const cos = Math.cos(-rot), sin = Math.sin(-rot);
  const lx = cx + (wx - cx) * cos - (wy - cy) * sin;
  const ly = cy + (wx - cx) * sin + (wy - cy) * cos;
  if (n.type === 'rect') {
    const c = n.corners || {};
    if (c.tl || c.tr || c.br || c.bl) return n.id;
    if (lx >= n.x && lx <= n.x + n.w && ly >= n.y && ly <= n.y + n.h) return n.id;
  } else if (n.type === 'ellipse') {
    const ex = (lx - cx) / (n.w / 2), ey = (ly - cy) / (n.h / 2);
    if (ex * ex + ey * ey <= 1) return n.id;
  } else if (n.type === 'line') {
    if (pointToSegmentDist(lx, ly, n.x, n.y, n.x+n.w, n.y+n.h) < Math.max((n.style?.strokeWidth || 2) / 2 + 4, 8)) return n.id;
  } else if (n.type === 'text' || n.type === 'image') {
    return n.id;
  } else if (n.type === 'path') {
    const path = getPath2D(n), hc = getHitCtx();
    hc.setTransform(1, 0, 0, 1, 0, 0);
    hc.translate(cx, cy); hc.rotate(rot); hc.translate(-cx, -cy);
    if (getSubpaths(n).some(sp => sp.closed) && n.style?.fill && n.style?.fill !== 'none' && hc.isPointInPath(path, wx, wy)) return n.id;
    hc.lineWidth = Math.max((n.style?.strokeWidth || 0) + 6, 10);
    if (hc.isPointInStroke(path, wx, wy)) return n.id;
  }
  return null;
}
function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2-x1, dy = y2-y1, len2 = dx*dx + dy*dy;
  if (len2 < 0.0001) return Math.hypot(px-x1, py-y1);
  let t = ((px-x1)*dx + (py-y1)*dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t*dx), py - (y1 + t*dy));
}

/* ============ OVERLAY ============ */
function handleRect(pos, px, py, id, hs, hitHs, zoom) {
  return `<g><rect data-handle="${pos}" data-id="${id}" x="${px-hitHs}" y="${py-hitHs}" width="${hitHs*2}" height="${hitHs*2}" fill="transparent" stroke="none" pointer-events="all" style="cursor:${pos}-resize"/><rect x="${px-hs}" y="${py-hs}" width="${hs*2}" height="${hs*2}" fill="white" stroke="#0af" stroke-width="${1/zoom}" pointer-events="none"/></g>`;
}
function anchorCircle(nodeId, si, ai, a, opts) {
  const { isSel, isPenFirst, hitRadius, visSize, lineW } = opts;
  return `<circle data-path-id="${nodeId}" data-subpath-index="${si}" data-anchor-index="${ai}" cx="${a.x}" cy="${a.y}" r="${hitRadius}" fill="transparent" pointer-events="all" style="cursor:move"/><circle cx="${a.x}" cy="${a.y}" r="${visSize}" fill="${isSel ? '#0af' : (isPenFirst ? '#4ecdc4' : 'white')}" stroke="${isSel ? '#0066aa' : '#0af'}" stroke-width="${lineW}" pointer-events="none"/>`;
}
function controlHandle(nodeId, si, ai, a, side, cSize, cHit, lineW) {
  const cx = a.x + (side === 'in' ? a.cIn.x : a.cOut.x);
  const cy = a.y + (side === 'in' ? a.cIn.y : a.cOut.y);
  return `<line x1="${a.x}" y1="${a.y}" x2="${cx}" y2="${cy}" stroke="#ff8800" stroke-width="${lineW}" pointer-events="none"/><circle data-path-id="${nodeId}" data-subpath-index="${si}" data-handle-index="${ai}" data-handle-side="${side}" cx="${cx}" cy="${cy}" r="${cHit}" fill="transparent" pointer-events="all" style="cursor:grab"/><circle cx="${cx}" cy="${cy}" r="${cSize}" fill="#ff8800" stroke="white" stroke-width="${lineW}" pointer-events="none"/>`;
}
function drawSelectionOverlay(n) {
  const { zoom } = state.viewport;
  const offset = 8 / zoom, sw = 1.5 / zoom;
  const hs = getHandleScreenPx() / (2 * zoom);
  const hitHs = getHandleHitPx() / (2 * zoom);
  const selected = [...state.selection].map(getNode).filter(Boolean);
  const isMulti = selected.length !== 1;
  const isEditing = state.pathEditing === n.id || state.editingPowerClip === n.id;
  const isGroupOrPC = n.type === 'group' || n.type === 'powerclip';

  if (isGroupOrPC) {
    const b = getNodeBounds(n);
    const stroke = n.type === 'powerclip' ? '#ff8800' : '#0af';
    return `<rect x="${b.x-offset}" y="${b.y-offset}" width="${b.w+2*offset}" height="${b.h+2*offset}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="${6/zoom} ${3/zoom}" pointer-events="none"/>`;
  }
  if (isEditing) return '';

  // Text on path
  if (n.type === 'text' && n.attachedPath) {
    const b = computePathBounds({ subpaths: n.attachedPath.subpaths });
    return `<rect x="${b.x-offset}" y="${b.y-offset}" width="${b.w+2*offset}" height="${b.h+2*offset}" fill="none" stroke="#ff8800" stroke-width="${sw}" stroke-dasharray="${4/zoom} ${2/zoom}" pointer-events="none"/>`;
  }

  const { x: nx, y: ny, w, h, rotation } = n;
  const cx = nx + w/2, cy = ny + h/2;
  const rtf = rotation ? `rotate(${rotation} ${cx} ${cy})` : '';
  const ox = nx - offset, oy = ny - offset;
  const ow = w + 2*offset, oh = h + 2*offset;

  if (isMulti) {
    return `<g transform="${rtf}"><rect x="${ox}" y="${oy}" width="${ow}" height="${oh}" fill="none" stroke="#0af" stroke-width="${sw}" stroke-dasharray="${4/zoom} ${2/zoom}" pointer-events="none"/></g>`;
  }

  const isPath = n.type === 'path';
  const pts = [
    ['nw', ox, oy], ['n', ox + ow/2, oy], ['ne', ox + ow, oy],
    ['w', ox, oy + oh/2], ['e', ox + ow, oy + oh/2],
    ['sw', ox, oy + oh], ['s', ox + ow/2, oy + oh], ['se', ox + ow, oy + oh],
  ];
  const handles = isPath ? '' : pts.map(([pos, px, py]) => handleRect(pos, px, py, n.id, hs, hitHs, zoom)).join('');
  const rotY = oy - 16/zoom;
  const color = isPath ? '#ff8800' : '#0af';
  return `<g transform="${rtf}"><rect x="${ox}" y="${oy}" width="${ow}" height="${oh}" fill="none" stroke="${color}" stroke-width="${sw}" pointer-events="none"/>${handles}<line x1="${ox + ow/2}" y1="${oy}" x2="${ox + ow/2}" y2="${rotY}" stroke="${color}" stroke-width="${sw}" pointer-events="none"/><g><circle data-handle="rotate" data-id="${n.id}" cx="${ox + ow/2}" cy="${rotY}" r="${hitHs}" fill="transparent" stroke="none" pointer-events="all" style="cursor:grab"/><circle cx="${ox + ow/2}" cy="${rotY}" r="${hs}" fill="white" stroke="${color}" stroke-width="${1/zoom}" pointer-events="none"/></g></g>`;
}
function drawAnchorOverlay(node) {
  const { zoom } = state.viewport;
  const cx = node.x + node.w/2, cy = node.y + node.h/2;
  const rtf = node.rotation ? `rotate(${node.rotation} ${cx} ${cy})` : '';
  const touchMult = isTouchDevice() ? 1.5 : 1;
  const aSize = 6 / zoom, aHit = (16 * touchMult) / zoom;
  const cSize = 4 / zoom, cHit = (14 * touchMult) / zoom;
  const lineW = 1 / zoom;
  const isPen = state.pen.active && state.pen.nodeId === node.id;
  const subpaths = getSubpaths(node);
  let content = `<g transform="${rtf}">`;
  for (let si = 0; si < subpaths.length; si++) {
    const sp = subpaths[si];
    for (let i = 0; i < sp.anchors.length; i++) {
      const a = sp.anchors[i];
      if (a.cIn.x !== 0 || a.cIn.y !== 0) content += controlHandle(node.id, si, i, a, 'in', cSize, cHit, lineW);
      if (a.cOut.x !== 0 || a.cOut.y !== 0) content += controlHandle(node.id, si, i, a, 'out', cSize, cHit, lineW);
    }
    for (let i = 0; i < sp.anchors.length; i++) {
      const a = sp.anchors[i];
      const isSel = state.selectedAnchor !== -1 && typeof state.selectedAnchor === 'object' &&
        state.selectedAnchor.subpathIndex === si && state.selectedAnchor.anchorIndex === i;
      const isPenFirst = isPen && si === 0 && i === 0 && node.subpaths[0].anchors.length >= 3;
      const hitRadius = isPenFirst ? (isTouchDevice() ? 32 : 20) / zoom : aHit;
      const visSize = isPenFirst ? aSize * 1.5 : aSize;
      content += anchorCircle(node.id, si, i, a, { isSel, isPenFirst, hitRadius, visSize, lineW });
    }
  }
  content += '</g>';
  return content;
}
function shouldShowAnchors(node) {
  return node.type === 'path' && (state.pathEditing === node.id || (state.pen.active && state.pen.nodeId === node.id));
}
function renderOverlay() {
  const isPureViewportChange = (state.interaction && state.interaction.type === 'pan') || pinchState;
  if (isPureViewportChange) {
    const rootG = overlay.querySelector('g');
    if (rootG) {
      rootG.setAttribute('transform', viewportMatrix());
      updateFloatingToolbar();
      return;
    }
  }
  const { zoom } = state.viewport;
  const sw = 1.5 / zoom;
  let content = '';
  const selected = [...state.selection].map(getNode).filter(Boolean);

  for (const n of selected) {
    if (state.pen.active && state.pen.nodeId === n.id) continue;
    if (state.cropping && state.cropping.nodeId === n.id) continue;
    content += drawSelectionOverlay(n);
  }
  for (const n of state.doc.nodes) {
    if (!shouldShowAnchors(n)) continue;
    content += drawAnchorOverlay(n);
  }
  if (state.pen.active && state.pen.nodeId && state.pen.mousePos) {
    const node = getNode(state.pen.nodeId);
    if (node) {
      const sp = getSubpaths(node)[0];
      if (sp && sp.anchors.length > 0) {
        const last = sp.anchors[sp.anchors.length-1];
        content += `<line x1="${last.x}" y1="${last.y}" x2="${state.pen.mousePos.x}" y2="${state.pen.mousePos.y}" stroke="#0af" stroke-width="${1.5/zoom}" stroke-dasharray="${4/zoom} ${3/zoom}" pointer-events="none" opacity="0.7"/>`;
      }
    }
  }
  if (marqueeRect) {
    const { x1, y1, x2, y2 } = marqueeRect;
    content += `<rect x="${Math.min(x1,x2)}" y="${Math.min(y1,y2)}" width="${Math.abs(x2-x1)}" height="${Math.abs(y2-y1)}" fill="rgba(0,170,255,0.08)" stroke="#0af" stroke-width="${sw}" stroke-dasharray="${4/zoom} ${2/zoom}" pointer-events="none"/>`;
  }
  if (state.snapGuides) {
    const sg = state.snapGuides, dash = `${6/zoom} ${4/zoom}`;
    if (sg.guideX != null) content += `<line x1="${sg.guideX}" y1="-10000" x2="${sg.guideX}" y2="10000" stroke="#ff00ff" stroke-width="${1.5/zoom}" stroke-dasharray="${dash}" pointer-events="none" opacity="0.85"/>`;
    if (sg.guideY != null) content += `<line x1="-10000" y1="${sg.guideY}" x2="10000" y2="${sg.guideY}" stroke="#ff00ff" stroke-width="${1.5/zoom}" stroke-dasharray="${dash}" pointer-events="none" opacity="0.85"/>`;
  }

  // Guides
  const guides = state.doc.guides || [];
  for (const g of guides) {
    if (g.axis === 'v') {
      content += `<g data-guide-id="${g.id}"><line x1="${g.pos}" y1="-10000" x2="${g.pos}" y2="10000" stroke="transparent" stroke-width="${12/zoom}" pointer-events="stroke" style="cursor:ew-resize"/><line x1="${g.pos}" y1="-10000" x2="${g.pos}" y2="10000" stroke="#0af" stroke-width="${1/zoom}" stroke-dasharray="4 3" pointer-events="none"/></g>`;
    } else {
      content += `<g data-guide-id="${g.id}"><line x1="-10000" y1="${g.pos}" x2="10000" y2="${g.pos}" stroke="transparent" stroke-width="${12/zoom}" pointer-events="stroke" style="cursor:ns-resize"/><line x1="-10000" y1="${g.pos}" x2="10000" y2="${g.pos}" stroke="#0af" stroke-width="${1/zoom}" stroke-dasharray="4 3" pointer-events="none"/></g>`;
    }
  }

  // Crop handles
  if (state.cropping) {
    const cr = state.cropping.cropRect;
    const hs = 6 / zoom, hitHs = 18 / zoom;
    content += `<rect x="${cr.x}" y="${cr.y}" width="${cr.w}" height="${cr.h}" fill="none" stroke="white" stroke-width="${2/zoom}" pointer-events="none"/>`;
    const handles = [
      ['nw', cr.x, cr.y], ['n', cr.x + cr.w/2, cr.y], ['ne', cr.x + cr.w, cr.y],
      ['w', cr.x, cr.y + cr.h/2], ['e', cr.x + cr.w, cr.y + cr.h/2],
      ['sw', cr.x, cr.y + cr.h], ['s', cr.x + cr.w/2, cr.y + cr.h], ['se', cr.x + cr.w, cr.y + cr.h],
    ];
    for (const [pos, px, py] of handles) {
      content += `<g><rect data-crop-handle="${pos}" x="${px-hitHs}" y="${py-hitHs}" width="${hitHs*2}" height="${hitHs*2}" fill="transparent" pointer-events="all" style="cursor:${pos}-resize"/><rect x="${px-hs}" y="${py-hs}" width="${hs*2}" height="${hs*2}" fill="white" stroke="black" stroke-width="${1/zoom}" pointer-events="none"/></g>`;
    }
  }

  overlay.innerHTML = `<g transform="${viewportMatrix()}">${content}</g>`;
  updateFloatingToolbar();
}

/* ============ FLOATING TOOLBAR ============ */
function toolbarSignature() {
  if (state.cropping) return 'crop';
  if (state.pen.active) {
    const node = getNode(state.pen.nodeId);
    const sp = node ? getSubpaths(node)[0] : null;
    return `pen:${sp ? sp.anchors.length : 0}`;
  }
  if (state.editingPowerClip) return `pc-edit`;
  if (state.pathEditing) {
    return state.selectedAnchor === -1 ? `edit:none` : `edit:${state.selectedAnchor.subpathIndex}:${state.selectedAnchor.anchorIndex}`;
  }
  const sel = [...state.selection].map(getNode).filter(Boolean);
  if (sel.length === 1 && sel[0].type === 'path') return `sel:${sel[0].id}`;
  if (sel.length === 1 && sel[0].type === 'powerclip') return `pc:${sel[0].id}`;
  if (sel.length === 1 && sel[0].type === 'text' && sel[0].attachedPath) return `text-path:${sel[0].id}`;
  return 'none';
}
function addToolbarButton(label, title, action, active) {
  const btn = document.createElement('button');
  btn.textContent = label; btn.title = title;
  if (active) btn.classList.add('active');
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => { e.stopPropagation(); action(); });
  floatingToolbar.appendChild(btn);
}
function rebuildFloatingToolbar() {
  floatingToolbar.innerHTML = '';
  if (state.cropping) {
    addToolbarButton('✓', 'Apply crop', applyCrop);
    addToolbarButton('✕', 'Cancel crop', cancelCrop);
    floatingToolbar.style.display = 'flex';
    return;
  }
  if (state.pen.active) {
    const node = getNode(state.pen.nodeId);
    const sp = node ? getSubpaths(node)[0] : null;
    const n = sp ? sp.anchors.length : 0;
    if (n === 0) { floatingToolbar.style.display = 'none'; return; }
    if (n >= 3) addToolbarButton('○', 'Close', () => {
      const nd = getNode(state.pen.nodeId);
      if (nd) { getSubpaths(nd)[0].closed = true; finishPenPath(); }
    });
    if (n >= 2) addToolbarButton('✓', 'Finish', () => finishPenPath());
    addToolbarButton('✕', 'Cancel', () => cancelPenPath());
    floatingToolbar.style.display = 'flex'; return;
  }
  if (state.editingPowerClip) {
    addToolbarButton('✓', 'Done editing', () => exitPowerClipEdit());
    addToolbarButton('📤', 'Extract', () => {
      const pcId = state.editingPowerClip;
      exitPowerClipEdit();
      if (getNode(pcId)) { state.selection = new Set([pcId]); extractPowerClip(); }
    });
    floatingToolbar.style.display = 'flex'; return;
  }
  if (state.pathEditing) {
    if (state.selectedAnchor !== -1) {
      const node = getNode(state.pathEditing);
      const sa = state.selectedAnchor;
      const sp = node ? getSubpaths(node)[sa.subpathIndex] : null;
      const a = sp ? sp.anchors[sa.anchorIndex] : null;
      if (a) {
        const smooth = isAnchorSmooth(node, sa.subpathIndex, sa.anchorIndex);
        addToolbarButton(smooth ? '◆' : '◯', smooth ? 'Make corner' : 'Make smooth', () => {
          const nd = getNode(state.pathEditing);
          if (!nd) return;
          beginInteraction();
          if (isAnchorSmooth(nd, sa.subpathIndex, sa.anchorIndex)) makeAnchorCorner(nd, sa.subpathIndex, sa.anchorIndex);
          else makeAnchorSmooth(nd, sa.subpathIndex, sa.anchorIndex);
          syncPathBounds(nd); endInteraction();
          scheduleRender();
        });
        addToolbarButton('🗑', 'Delete anchor', () => deleteSelectedAnchor());
      }
    }
    addToolbarButton('✓', 'Done', () => exitPathEdit());
    floatingToolbar.style.display = 'flex'; return;
  }
  const sel = [...state.selection].map(getNode).filter(Boolean);
  if (sel.length === 1 && sel[0].type === 'path') {
    addToolbarButton('✥', 'Move', () => showToast('Drag to move'), true);
    addToolbarButton('✏️', 'Edit anchors', () => enterPathEdit(sel[0].id));
    floatingToolbar.style.display = 'flex'; return;
  }
  if (sel.length === 1 && sel[0].type === 'powerclip') {
    addToolbarButton('✥', 'Move', () => showToast('Drag to move'), true);
    addToolbarButton('✏️', 'Edit contents', () => enterPowerClipEdit(sel[0].id));
    addToolbarButton('📤', 'Extract', () => extractPowerClip());
    floatingToolbar.style.display = 'flex'; return;
  }
  if (sel.length === 1 && sel[0].type === 'text' && sel[0].attachedPath) {
    addToolbarButton('✂️', 'Detach from path', () => detachTextFromPath());
    floatingToolbar.style.display = 'flex'; return;
  }
  floatingToolbar.style.display = 'none';
}
function repositionFloatingToolbar() {
  if (floatingToolbar.style.display === 'none') return;
  const areaRect = canvasArea.getBoundingClientRect();
  const tw = floatingToolbar.offsetWidth || 100, th = floatingToolbar.offsetHeight || 44;
  if (state.pen.active || state.pathEditing || state.editingPowerClip || state.cropping) {
    floatingToolbar.style.transform = 'translate(-50%, 0)';
    floatingToolbar.style.left = (areaRect.width / 2) + 'px';
    floatingToolbar.style.top = '30px';
    return;
  }
  const sel = [...state.selection].map(getNode).filter(Boolean);
  if (sel.length === 1 && (sel[0].type === 'path' || sel[0].type === 'powerclip' || (sel[0].type === 'text' && sel[0].attachedPath))) {
    const b = getNodeBounds(sel[0]);
    const center = worldToScreen(b.x + b.w / 2, b.y + b.h);
    let sx = Math.max(tw / 2 + 8, Math.min(areaRect.width - tw / 2 - 8, center.x + 22));
    let sy = Math.max(30, Math.min(areaRect.height - th - 8, center.y + 40));
    floatingToolbar.style.transform = 'translate(-50%, 0)';
    floatingToolbar.style.left = sx + 'px';
    floatingToolbar.style.top = sy + 'px';
  }
}
function updateFloatingToolbar() {
  const sig = toolbarSignature();
  if (sig !== lastToolbarSig) { lastToolbarSig = sig; rebuildFloatingToolbar(); }
  repositionFloatingToolbar();
}

/* ============ ANCHOR OPS ============ */
function isAnchorSmooth(node, si, ai) {
  const sp = getSubpaths(node)[si];
  const a = sp && sp.anchors[ai];
  return a ? (Math.hypot(a.cIn.x, a.cIn.y) > 0.001 || Math.hypot(a.cOut.x, a.cOut.y) > 0.001) : false;
}
function makeAnchorSmooth(node, si, ai) {
  const sp = getSubpaths(node)[si];
  const anchors = sp.anchors;
  const a = anchors[ai];
  const prev = ai > 0 ? anchors[ai-1] : (sp.closed ? anchors[anchors.length-1] : null);
  const next = ai < anchors.length-1 ? anchors[ai+1] : (sp.closed ? anchors[0] : null);
  let dx, dy;
  if (prev && next) { dx = next.x - prev.x; dy = next.y - prev.y; }
  else if (next) { dx = next.x - a.x; dy = next.y - a.y; }
  else if (prev) { dx = a.x - prev.x; dy = a.y - prev.y; }
  else return;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return;
  const ux = dx/len, uy = dy/len;
  const dPrev = prev ? Math.hypot(a.x-prev.x, a.y-prev.y) / 3 : len / 6;
  const dNext = next ? Math.hypot(next.x-a.x, next.y-a.y) / 3 : len / 6;
  a.cIn = { x: -ux*dPrev, y: -uy*dPrev };
  a.cOut = { x: ux*dNext, y: uy*dNext };
}
function makeAnchorCorner(node, si, ai) {
  const sp = getSubpaths(node)[si];
  if (sp && sp.anchors[ai]) { sp.anchors[ai].cIn = { x:0, y:0 }; sp.anchors[ai].cOut = { x:0, y:0 }; }
}
function deleteSelectedAnchor() {
  if (!state.pathEditing || state.selectedAnchor === -1) return;
  const node = getNode(state.pathEditing);
  if (!node || node.type !== 'path') return;
  const sa = state.selectedAnchor;
  const sp = getSubpaths(node)[sa.subpathIndex];
  if (!sp) return;
  beginInteraction();
  sp.anchors.splice(sa.anchorIndex, 1);
  if (sp.anchors.length < 2) {
    node.subpaths.splice(sa.subpathIndex, 1);
    if (!node.subpaths.length) {
      const info = findNodeAndParent(node.id);
      if (info) info.list.splice(info.index, 1);
      state.selection.delete(node.id);
      state.pathEditing = null; state.selectedAnchor = -1;
    }
  } else {
    syncPathBounds(node);
    state.selectedAnchor = { subpathIndex: sa.subpathIndex, anchorIndex: Math.min(sa.anchorIndex, sp.anchors.length-1) };
  }
  endInteraction();
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
}

/* ============ BOOLEAN ============ */
function shapeToPolygon(node, samples = 20) {
  if (node.type === 'rect') {
    const c = node.corners || {};
    if (c.tl || c.tr || c.br || c.bl) {
      const tempPath = { ...node, type: 'path', subpaths: [{
        anchors: [makeAnchor(node.x, node.y), makeAnchor(node.x+node.w, node.y),
                  makeAnchor(node.x+node.w, node.y+node.h), makeAnchor(node.x, node.y+node.h)], closed: true }]};
      return pathToPolygon(tempPath, samples);
    }
    return [[[node.x, node.y], [node.x+node.w, node.y], [node.x+node.w, node.y+node.h], [node.x, node.y+node.h]]];
  }
  if (node.type === 'ellipse') {
    const cx = node.x + node.w/2, cy = node.y + node.h/2;
    const rx = node.w/2, ry = node.h/2;
    const pts = [], N = 32;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      pts.push([cx + rx*Math.cos(t), cy + ry*Math.sin(t)]);
    }
    return [pts];
  }
  if (node.type === 'path') return pathToPolygon(node, samples);
  return null;
}
function pathToPolygon(node, samples) {
  const rings = [];
  for (const sp of getSubpaths(node)) {
    const anchors = sp.anchors;
    if (anchors.length < 2) continue;
    const pts = [[anchors[0].x, anchors[0].y]];
    const segCount = sp.closed ? anchors.length : anchors.length - 1;
    for (let i = 0; i < segCount; i++) {
      const a = anchors[i], b = anchors[(i+1) % anchors.length];
      for (let s = 1; s <= samples; s++) {
        const p = cubicBezierPoint(
          { x: a.x, y: a.y }, { x: a.x+a.cOut.x, y: a.y+a.cOut.y },
          { x: b.x+b.cIn.x, y: b.y+b.cIn.y }, { x: b.x, y: b.y }, s / samples);
        pts.push([p.x, p.y]);
      }
    }
    if (pts.length > 0) rings.push(pts);
  }
  return rings;
}
async function doBoolean(op) {
  const selIds = [...state.selection];
  if (selIds.length < 2) return;
  let pc;
  try { pc = await ensurePolygonClipping(); }
  catch (e) { showToast('Boolean lib failed to load'); return; }
  if (!pc) { showToast('Boolean lib not available'); return; }
  const stillSel = selIds.map(getNode).filter(Boolean);
  if (stillSel.length < 2) { showToast('Selection changed'); return; }
  const polygons = [];
  for (const n of stillSel) {
    const poly = shapeToPolygon(n);
    if (!poly) { showToast('Unsupported: ' + n.type); return; }
    polygons.push(poly);
  }
  let result;
  try {
    const ops = {
      union: () => pc.union(...polygons),
      subtract: () => pc.difference(polygons[0], ...polygons.slice(1)),
      intersect: () => pc.intersection(...polygons),
      exclude: () => pc.xor(...polygons),
    };
    result = ops[op]();
  } catch (e) { showToast('Boolean error'); return; }
  if (!result || !result.length) { showToast('Empty result'); return; }
  const subpaths = [];
  for (const polygon of result) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      const anchors = ring.slice(0, ring.length-1).map(([x, y]) => makeAnchor(x, y));
      if (anchors.length < 2) continue;
      subpaths.push({ anchors, closed: true });
    }
  }
  if (!subpaths.length) { showToast('Empty result'); return; }
  const firstStyle = JSON.parse(JSON.stringify(stillSel[0].style || {}));
  commitChange(() => {
    for (const id of state.selection) {
      const info = findNodeAndParent(id);
      if (info) info.list.splice(info.index, 1);
    }
    const newNode = { id: genId(), type: 'path', name: capitalize(op),
      subpaths, fillRule: 'evenodd', x: 0, y: 0, w: 0, h: 0, rotation: 0, style: firstStyle };
    syncPathBounds(newNode);
    state.doc.nodes.push(newNode);
    state.selection = new Set([newNode.id]);
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('✓ ' + capitalize(op));
}
document.querySelectorAll('[data-bool]').forEach(btn => {
  btn.addEventListener('click', () => doBoolean(btn.dataset.bool).catch(() => showToast('Boolean failed')));
});

/* ============ HISTORY ============ */
function beginInteraction() { state.snapshotBefore = JSON.stringify(state.doc); }
function endInteraction() {
  if (state.snapshotBefore === null) return;
  if (state.snapshotBefore !== JSON.stringify(state.doc)) {
    state.history.undo.push(state.snapshotBefore);
    state.history.redo = [];
    updateHistoryButtons();
    scheduleAutosave();
  }
  state.snapshotBefore = null;
}
function commitChange(fn) {
  const before = JSON.stringify(state.doc);
  fn();
  if (before !== JSON.stringify(state.doc)) {
    state.history.undo.push(before);
    state.history.redo = [];
    updateHistoryButtons();
    scheduleAutosave();
  }
}
function resetAfterHistory() {
  state.selection.clear();
  state.snapGuides = null;
  state.pathEditing = null;
  state.selectedAnchor = -1;
  state.pen = { active: false, nodeId: null, dragAnchorIndex: -1, mousePos: null, dragging: false };
  state.editingPowerClip = null;
  state._editingContentsIds = null;
  state.cropping = null;
}
function undo() {
  if (!state.history.undo.length) return;
  state.history.redo.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(state.history.undo.pop());
  resetAfterHistory();
  afterHistoryChange();
}
function redo() {
  if (!state.history.redo.length) return;
  state.history.undo.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(state.history.redo.pop());
  resetAfterHistory();
  afterHistoryChange();
}
function afterHistoryChange() {
  render(); renderOverlay();
  updatePropertiesPanel(); updateLayersPanel(); updateHistoryButtons(); updateCanvasSizeUI();
  scheduleAutosave();
}
function updateHistoryButtons() {
  document.getElementById('btnUndo').disabled = state.history.undo.length === 0;
  document.getElementById('btnRedo').disabled = state.history.redo.length === 0;
}

/* ============ COPY / PASTE ============ */
function deepCloneWithNewIds(node) {
  const clone = JSON.parse(JSON.stringify(node));
  function reassign(n) {
    n.id = genId();
    if (n.type === 'group' && n.children) for (const c of n.children) reassign(c);
    if (n.type === 'powerclip') {
      if (n.container) reassign(n.container);
      if (n.contents) for (const c of n.contents) reassign(c);
    }
  }
  reassign(clone);
  return clone;
}
function offsetNode(node, dx, dy) {
  node.x += dx; node.y += dy;
  if (node.subpaths) for (const sp of node.subpaths) for (const a of sp.anchors) { a.x += dx; a.y += dy; }
  else if (node.anchors) for (const a of node.anchors) { a.x += dx; a.y += dy; }
  if (node.type === 'group' && node.children) for (const c of node.children) offsetNode(c, dx, dy);
  if (node.type === 'powerclip') {
    if (node.container) offsetNode(node.container, dx, dy);
    if (node.contents) for (const c of node.contents) offsetNode(c, dx, dy);
  }
}
function copySelected() {
  if (!state.selection.size) return;
  const items = [];
  for (const id of state.selection) {
    const top = getTopLevelAncestor(id);
    if (top && !items.find(i => i.id === top.id)) items.push(JSON.parse(JSON.stringify(top)));
  }
  state.clipboard = items;
  state.pasteCount = 0;
  showToast('📋 Copied ' + items.length);
}
function pasteClipboard() {
  if (!state.clipboard || !state.clipboard.length) { showToast('Clipboard empty'); return; }
  state.pasteCount++;
  const offset = 20 * state.pasteCount;
  commitChange(() => {
    const newIds = [];
    for (const item of state.clipboard) {
      const clone = deepCloneWithNewIds(item);
      offsetNode(clone, offset, offset);
      state.doc.nodes.push(clone);
      newIds.push(clone.id);
    }
    state.selection = new Set(newIds);
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('✓ Pasted');
}
function duplicateSelected() {
  if (!state.selection.size) return;
  const items = [];
  for (const id of state.selection) {
    const top = getTopLevelAncestor(id);
    if (top && !items.find(i => i.id === top.id)) items.push(top);
  }
  commitChange(() => {
    const newIds = [];
    for (const item of items) {
      const clone = deepCloneWithNewIds(item);
      offsetNode(clone, 20, 20);
      state.doc.nodes.push(clone);
      newIds.push(clone.id);
    }
    state.selection = new Set(newIds);
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('✓ Duplicated');
}
function reorderSelection(front) {
  if (!state.selection.size) return;
  commitChange(() => {
    const items = [];
    for (const id of state.selection) {
      const info = findNodeAndParent(id);
      if (info) { info.list.splice(info.index, 1); items.push(info.node); }
    }
    if (front) state.doc.nodes.push(...items);
    else state.doc.nodes.unshift(...items);
  });
  scheduleRender(); updateLayersPanel();
}
const bringToFront = () => reorderSelection(true);
const sendToBack = () => reorderSelection(false);

/* ============ CONTEXT MENU ============ */
function showContextMenu(x, y, targetNodeId) {
  closeAllMenus();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const items = [];
  const boolAction = (op) => () => doBoolean(op).catch(() => showToast('Boolean failed'));

  if (targetNodeId && state.selection.has(targetNodeId)) {
    const sel = [...state.selection].map(getNode).filter(Boolean);
    items.push({ label: '📋 Copy', action: copySelected });
    items.push({ label: '⧉ Duplicate', action: duplicateSelected });
    items.push({ sep: true });
    if (sel.length >= 2) {
      items.push({ label: '📦 Create PowerClip', action: createPowerClip });
      const hasText = sel.some(x => x.type === 'text');
      const hasPath = sel.some(x => x.type === 'path');
      if (hasText && hasPath && sel.length === 2) {
        items.push({ label: '✏️ Attach text to path', action: attachTextToPath });
      }
      items.push({ sep: true });
      items.push({ label: '∪ Union', action: boolAction('union') });
      items.push({ label: '− Subtract', action: boolAction('subtract') });
      items.push({ label: '∩ Intersect', action: boolAction('intersect') });
      items.push({ label: '⊕ Exclude', action: boolAction('exclude') });
      items.push({ sep: true });
    }
    if (sel.length === 1 && sel[0].type === 'powerclip') {
      const pcId = sel[0].id;
      if (state.editingPowerClip === pcId) items.push({ label: '✓ Done editing', action: exitPowerClipEdit });
      else {
        items.push({ label: '✏️ Edit contents', action: () => enterPowerClipEdit(pcId) });
        items.push({ label: '📤 Extract contents', action: extractPowerClip });
      }
      items.push({ sep: true });
    }
    if (sel.length === 1 && sel[0].type === 'text' && sel[0].attachedPath) {
      items.push({ label: '✂️ Detach from path', action: detachTextFromPath });
      items.push({ sep: true });
    }
    if (sel.length === 1 && sel[0].type === 'image') {
      items.push({ label: '✂️ Crop image', action: () => enterCropMode(sel[0].id) });
      items.push({ sep: true });
    }
    items.push({ label: '⬆ Bring to Front', action: bringToFront });
    items.push({ label: '⬇ Send to Back', action: sendToBack });
    items.push({ sep: true });
    items.push({ label: '🗑 Delete', action: deleteSelected });
  } else if (targetNodeId) {
    const id = targetNodeId;
    items.push({ label: '📋 Copy', action: () => { state.selection = new Set([id]); copySelected(); } });
    items.push({ label: '⧉ Duplicate', action: () => { state.selection = new Set([id]); duplicateSelected(); } });
    items.push({ sep: true });
    items.push({ label: '⬆ Bring to Front', action: () => { state.selection = new Set([id]); bringToFront(); } });
    items.push({ label: '⬇ Send to Back', action: () => { state.selection = new Set([id]); sendToBack(); } });
    items.push({ sep: true });
    items.push({ label: '🗑 Delete', action: () => { state.selection = new Set([id]); deleteSelected(); } });
  } else {
    const disabled = !state.clipboard || !state.clipboard.length;
    items.push({ label: '📋 Paste', action: pasteClipboard, disabled });
    items.push({ sep: true });
    items.push({ label: '⤢ Fit to View', action: fitToView });
  }
  menu.innerHTML = items.map((item, i) => {
    if (item.sep) return '<div class="menu-sep"></div>';
    return `<button data-i="${i}" ${item.disabled ? 'disabled' : ''}>${escapeHtml(item.label)}</button>`;
  }).join('');
  document.body.appendChild(menu);
  contextMenuEl = menu;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + 'px';
  menu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = items[parseInt(btn.dataset.i)];
      closeAllMenus();
      if (item && item.action && !item.disabled) item.action();
    });
  });
}

scene.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const rect = getSceneRect();
  const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  let nodeId = hitTest(world.x, world.y);
  if (nodeId) { const top = getTopLevelAncestor(nodeId); if (top) nodeId = top.id; }
  if (nodeId && !state.selection.has(nodeId)) {
    state.selection = new Set([nodeId]);
    scheduleRender(); updatePropertiesPanel(); updateLayersPanel();
  }
  showContextMenu(e.clientX, e.clientY, nodeId);
});

let longPressTimer = null, longPressStart = { x: 0, y: 0 }, longPressMoved = false;
scene.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || e.button !== 0) return;
  longPressStart = { x: e.clientX, y: e.clientY };
  longPressMoved = false;
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    if (longPressMoved) return;
    const rect = getSceneRect();
    const world = screenToWorld(longPressStart.x - rect.left, longPressStart.y - rect.top);
    let nodeId = hitTest(world.x, world.y);
    if (nodeId) { const top = getTopLevelAncestor(nodeId); if (top) nodeId = top.id; }
    if (nodeId && !state.selection.has(nodeId)) {
      state.selection = new Set([nodeId]);
      scheduleRender(); updatePropertiesPanel(); updateLayersPanel();
    }
    if (navigator.vibrate) navigator.vibrate(20);
    showContextMenu(longPressStart.x, longPressStart.y, nodeId);
  }, 550);
});
scene.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') return;
  if (Math.hypot(e.clientX - longPressStart.x, e.clientY - longPressStart.y) > 10) {
    longPressMoved = true; clearTimeout(longPressTimer);
  }
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(evt => {
  scene.addEventListener(evt, () => clearTimeout(longPressTimer));
});

/* ============ PINCH ZOOM ============ */
function onCanvasPointerDown(e) {
  touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touchPointers.size === 2) {
    clearTimeout(longPressTimer);
    if (state.interaction) { state.interaction = null; marqueeRect = null; }
    if (activePointerId !== null) {
      if (pointerAbort) { pointerAbort.abort(); pointerAbort = null; }
      activePointerId = null; endInteraction();
    }
    const pts = [...touchPointers.values()];
    const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    pinchState = {
      startDist: Math.max(1, dist), startZoom: state.viewport.zoom,
      startCenter: { x: cx, y: cy },
      startVp: { x: state.viewport.x, y: state.viewport.y },
    };
  }
}
function onCanvasPointerMove(e) {
  if (touchPointers.has(e.pointerId)) touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinchState || touchPointers.size < 2) return;
  const pts = [...touchPointers.values()];
  const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
  const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  const rect = canvasArea.getBoundingClientRect();
  const scale = dist / pinchState.startDist;
  const newZoom = Math.max(0.05, Math.min(20, pinchState.startZoom * scale));
  const localCx0 = pinchState.startCenter.x - rect.left;
  const localCy0 = pinchState.startCenter.y - rect.top;
  const wx = (localCx0 - pinchState.startVp.x) / pinchState.startZoom;
  const wy = (localCy0 - pinchState.startVp.y) / pinchState.startZoom;
  state.viewport.zoom = newZoom;
  state.viewport.x = (cx - rect.left) - wx * newZoom;
  state.viewport.y = (cy - rect.top) - wy * newZoom;
  scheduleRender(); updateZoomLabel();
}
function onCanvasPointerUp(e) {
  touchPointers.delete(e.pointerId);
  if (touchPointers.size < 2) pinchState = null;
}

/* ============ PEN TOOL ============ */
function onPenPointerDown(e, world) {
  if (!state.pen.active) {
    beginInteraction();
    const id = genId();
    const node = {
      id, type: 'path', name: 'Path',
      x: world.x, y: world.y, w: 0, h: 0, rotation: 0,
      subpaths: [{ anchors: [makeAnchor(world.x, world.y)], closed: false }],
      style: { fill: state.defaultStyle.fill, stroke: state.defaultStyle.stroke,
               strokeWidth: state.defaultStyle.strokeWidth || 2, opacity: 1 },
    };
    state.doc.nodes.push(node);
    state.pen.active = true; state.pen.nodeId = id;
    state.pen.dragAnchorIndex = 0; state.pen.dragging = false;
    state.pen.mousePos = world;
    state.selection = new Set([id]);
    scheduleRender(); updateLayersPanel();
    return;
  }
  const node = getNode(state.pen.nodeId);
  if (!node) { resetPen(); return; }
  const sp = getSubpaths(node)[0];
  if (!sp) { resetPen(); return; }
  if (sp.anchors.length >= 3) {
    const first = sp.anchors[0];
    const dist = Math.hypot(world.x - first.x, world.y - first.y);
    const closeThreshold = (isTouchDevice() ? 40 : 24) / state.viewport.zoom;
    if (dist < closeThreshold) { sp.closed = true; finishPenPath(); return; }
  }
  sp.anchors.push(makeAnchor(world.x, world.y));
  state.pen.dragAnchorIndex = sp.anchors.length - 1;
  state.pen.dragging = false; state.pen.mousePos = world;
  scheduleRender();
}
function onPenPointerMove(world) {
  state.pen.mousePos = world;
  if (state.pen.dragAnchorIndex < 0) { scheduleRender(); return; }
  const node = getNode(state.pen.nodeId);
  if (!node) return;
  const sp = getSubpaths(node)[0];
  if (!sp) return;
  const a = sp.anchors[state.pen.dragAnchorIndex];
  if (!a) return;
  const dx = world.x - a.x, dy = world.y - a.y;
  if (Math.hypot(dx, dy) > 3 / state.viewport.zoom) {
    a.cOut = { x: dx, y: dy }; a.cIn = { x: -dx, y: -dy };
    state.pen.dragging = true;
  } else if (state.pen.dragging) {
    a.cOut = { x: 0, y: 0 }; a.cIn = { x: 0, y: 0 };
    state.pen.dragging = false;
  }
  scheduleRender();
}
function onPenPointerUp() { state.pen.dragAnchorIndex = -1; state.pen.dragging = false; }
function finishPenPath() {
  const node = getNode(state.pen.nodeId);
  if (!node) { resetPen(); return; }
  const sp = getSubpaths(node)[0];
  if (!sp || sp.anchors.length < 2) {
    const info = findNodeAndParent(node.id);
    if (info) info.list.splice(info.index, 1);
    state.selection.clear();
  } else syncPathBounds(node);
  resetPen(); endInteraction();
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
}
function cancelPenPath() {
  const node = getNode(state.pen.nodeId);
  if (node) { const info = findNodeAndParent(node.id); if (info) info.list.splice(info.index, 1); }
  resetPen(); state.snapshotBefore = null; state.selection.clear();
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
}
function resetPen() { state.pen = { active: false, nodeId: null, dragAnchorIndex: -1, mousePos: null, dragging: false }; }

/* ============ POINTER ============ */
function onScenePointerDown(e) {
  if (pinchState || e.button !== 0) return;
  e.preventDefault();
  const rect = getSceneRect();
  const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

  if (state.tool === 'hand') { startPan(e); return; }
  if (state.tool === 'pen') { onPenPointerDown(e, world); attachPointerHandlers(e.pointerId); return; }

  // Crop mode drag inside
  if (state.cropping) {
    const cr = state.cropping.cropRect;
    if (world.x >= cr.x && world.x <= cr.x + cr.w && world.y >= cr.y && world.y <= cr.y + cr.h) {
      beginInteraction();
      state.interaction = { type: 'crop-move', startRect: { ...cr }, startPointer: world };
      attachPointerHandlers(e.pointerId);
    }
    return;
  }

  if (state.pathEditing) {
    const hitId = hitTest(world.x, world.y);
    const top = hitId ? getTopLevelAncestor(hitId) : null;
    if (top && top.id === state.pathEditing) {
      const node = getNode(state.pathEditing);
      if (node) {
        let best = null;
        for (let si = 0; si < getSubpaths(node).length; si++) {
          const sp = getSubpaths(node)[si];
          const r = findClosestPointOnSubpath(sp, world.x, world.y);
          if (r && (!best || r.dist < best.dist)) best = { ...r, si };
        }
        const threshold = (isTouchDevice() ? 24 : 15) / state.viewport.zoom;
        if (best && best.dist <= threshold) {
          beginInteraction();
          const newAi = insertAnchorAtPoint(node, best.si, best.segmentIndex, best.t);
          syncPathBounds(node);
          state.selectedAnchor = { subpathIndex: best.si, anchorIndex: newAi };
          endInteraction();
          scheduleRender();
          showToast('Anchor added');
        }
      }
      return;
    }
    exitPathEdit();
  }

  if (state.tool !== 'select') { startDraw(state.tool, world); attachPointerHandlers(e.pointerId); return; }

  let nodeId = hitTest(world.x, world.y);
  if (nodeId) { const top = getTopLevelAncestor(nodeId); if (top) nodeId = top.id; }

  if (nodeId) {
    if (e.shiftKey) {
      if (state.selection.has(nodeId)) state.selection.delete(nodeId);
      else state.selection.add(nodeId);
      scheduleRender(); updatePropertiesPanel(); updateLayersPanel();
      return;
    }
    if (!state.selection.has(nodeId)) {
      state.selection.clear(); state.selection.add(nodeId);
      scheduleRender(); updatePropertiesPanel(); updateLayersPanel();
    }
    beginInteraction();
    const startNodes = [];
    for (const id of state.selection) {
      const n = getNode(id);
      if (!n) continue;
      for (const leaf of collectLeaves(n)) {
        startNodes.push({
          id: leaf.id, ref: leaf,
          x: leaf.x, y: leaf.y,
          subpaths: leaf.subpaths ? JSON.parse(JSON.stringify(leaf.subpaths)) : null,
          anchors: leaf.anchors ? JSON.parse(JSON.stringify(leaf.anchors)) : null,
        });
      }
    }
    state.interaction = { type: 'move', startPos: world, startNodes };
    attachPointerHandlers(e.pointerId);
  } else {
    if (!e.shiftKey) {
      state.selection.clear();
      scheduleRender(); updatePropertiesPanel(); updateLayersPanel();
    }
    state.interaction = { type: 'marquee', start: world, additive: e.shiftKey, originalSelection: new Set(state.selection) };
    marqueeRect = { x1: world.x, y1: world.y, x2: world.x, y2: world.y };
    attachPointerHandlers(e.pointerId);
  }
}
function findClosestPointOnSubpath(sp, cx, cy) {
  const anchors = sp.anchors;
  if (anchors.length < 2) return null;
  let best = { segmentIndex: -1, t: 0, dist: Infinity };
  const segCount = sp.closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = anchors[i], b = anchors[(i+1) % anchors.length];
    for (let s = 1; s < 30; s++) {
      const t = s / 30;
      const pt = cubicBezierPoint(
        { x: a.x, y: a.y }, { x: a.x+a.cOut.x, y: a.y+a.cOut.y },
        { x: b.x+b.cIn.x, y: b.y+b.cIn.y }, { x: b.x, y: b.y }, t);
      const d = Math.hypot(pt.x - cx, pt.y - cy);
      if (d < best.dist) best = { segmentIndex: i, t, dist: d };
    }
  }
  return best;
}
function insertAnchorAtPoint(node, si, segIndex, t) {
  const sp = getSubpaths(node)[si];
  const anchors = sp.anchors;
  const a = anchors[segIndex], b = anchors[(segIndex+1) % anchors.length];
  const p0 = { x: a.x, y: a.y }, p1 = { x: a.x+a.cOut.x, y: a.y+a.cOut.y };
  const p2 = { x: b.x+b.cIn.x, y: b.y+b.cIn.y }, p3 = { x: b.x, y: b.y };
  const A = lerp2(p0, p1, t), B = lerp2(p1, p2, t), C = lerp2(p2, p3, t);
  const D = lerp2(A, B, t), E = lerp2(B, C, t), F = lerp2(D, E, t);
  a.cOut = { x: A.x-p0.x, y: A.y-p0.y };
  b.cIn = { x: C.x-p3.x, y: C.y-p3.y };
  anchors.splice(segIndex + 1, 0, { x: F.x, y: F.y, cIn: { x: D.x-F.x, y: D.y-F.y }, cOut: { x: E.x-F.x, y: E.y-F.y } });
  return segIndex + 1;
}

function onOverlayPointerDown(e) {
  if (pinchState) return;
  const d = e.target.dataset || {};

  // Guide drag
  const guideEl = e.target.closest('[data-guide-id]');
  if (guideEl) {
    e.preventDefault(); e.stopPropagation();
    const g = (state.doc.guides || []).find(x => x.id === guideEl.dataset.guideId);
    if (!g) return;
    const rect = getSceneRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    beginInteraction();
    state.interaction = { type: 'guide-drag', guideId: g.id, axis: g.axis, startPos: g.pos, startPointer: world };
    attachPointerHandlers(e.pointerId);
    return;
  }

  // Crop handle
  if (d.cropHandle && state.cropping) {
    e.preventDefault(); e.stopPropagation();
    const rect = getSceneRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    beginInteraction();
    state.interaction = {
      type: 'crop-resize', handle: d.cropHandle,
      startRect: { ...state.cropping.cropRect },
      startPointer: world,
    };
    attachPointerHandlers(e.pointerId);
    return;
  }

  const { anchorIndex: anchorIdx, handleIndex: handleIdx, handleSide, subpathIndex: subpathIdx, pathId, handle, id: nodeId } = d;

  if (anchorIdx !== undefined && pathId) {
    e.preventDefault(); e.stopPropagation();
    const node = getNode(pathId);
    if (!node || node.type !== 'path') return;
    const si = parseInt(subpathIdx || 0), ai = parseInt(anchorIdx);
    if (state.pen.active && state.pen.nodeId === pathId) {
      const sp = getSubpaths(node)[si];
      if (si === 0 && ai === 0 && sp && sp.anchors.length >= 3) { sp.closed = true; finishPenPath(); return; }
    }
    const sp = getSubpaths(node)[si];
    const a = sp && sp.anchors[ai];
    if (!a) return;
    state.selectedAnchor = { subpathIndex: si, anchorIndex: ai };
    const rect = getSceneRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    beginInteraction();
    state.interaction = { type: 'anchor-drag', nodeId: pathId, subpathIndex: si, anchorIndex: ai, startPointer: world, startAnchor: { x: a.x, y: a.y } };
    attachPointerHandlers(e.pointerId);
    scheduleRender();
    return;
  }
  if (handleIdx !== undefined && pathId) {
    e.preventDefault(); e.stopPropagation();
    const node = getNode(pathId);
    if (!node || node.type !== 'path') return;
    beginInteraction();
    state.interaction = { type: 'handle-drag', nodeId: pathId, subpathIndex: parseInt(subpathIdx || 0), anchorIndex: parseInt(handleIdx), side: handleSide, symmetric: !e.altKey };
    attachPointerHandlers(e.pointerId);
    return;
  }
  if (!handle || !nodeId) return;
  e.preventDefault(); e.stopPropagation();
  const node = getNode(nodeId);
  if (!node || node.type === 'group') return;
  const rect = getSceneRect();
  const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  beginInteraction();
  if (handle === 'rotate') {
    const cx = node.x + node.w/2, cy = node.y + node.h/2;
    state.interaction = { type: 'rotate', nodeId, cx, cy, startAngle: Math.atan2(world.y - cy, world.x - cx), startRotation: node.rotation || 0 };
  } else {
    const cx = node.x + node.w/2, cy = node.y + node.h/2;
    const rad = (node.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const fixedLocal = {
      nw: { x: node.x + node.w, y: node.y + node.h }, n: { x: node.x + node.w/2, y: node.y + node.h },
      ne: { x: node.x, y: node.y + node.h }, w: { x: node.x + node.w, y: node.y + node.h/2 },
      e: { x: node.x, y: node.y + node.h/2 }, sw: { x: node.x + node.w, y: node.y },
      s: { x: node.x + node.w/2, y: node.y }, se: { x: node.x, y: node.y },
    }[handle];
    state.interaction = { type: 'resize', nodeId, handle, startNode: JSON.parse(JSON.stringify(node)), startPointer: world,
      cx, cy, cos, sin, fixedWorld: localToWorld(fixedLocal.x, fixedLocal.y, cx, cy, cos, sin) };
  }
  attachPointerHandlers(e.pointerId);
}

function startPan(e) {
  state.interaction = { type: 'pan', startScreen: { x: e.clientX, y: e.clientY }, startVp: { x: state.viewport.x, y: state.viewport.y } };
  attachPointerHandlers(e.pointerId);
}
function startDraw(tool, world) {
  beginInteraction();
  const id = genId();
  const node = { id, type: tool, x: world.x, y: world.y, w: 0, h: 0, rotation: 0, style: { ...state.defaultStyle } };
  if (tool === 'rect') node.corners = { tl: 0, tr: 0, br: 0, bl: 0 };
  if (tool === 'text') { node.text = 'Text'; node.fontSize = 32; }
  state.doc.nodes.push(node);
  state.selection = new Set([id]);
  state.interaction = { type: 'draw', tool, id, start: world };
  scheduleRender(); updateLayersPanel();
}
function attachPointerHandlers(pointerId) {
  activePointerId = pointerId;
  if (pointerAbort) pointerAbort.abort();
  pointerAbort = new AbortController();
  document.addEventListener('pointermove', onPointerMove, { signal: pointerAbort.signal });
  document.addEventListener('pointerup', onPointerUp, { signal: pointerAbort.signal });
  document.addEventListener('pointercancel', onPointerUp, { signal: pointerAbort.signal });
}

function applyResizeDeltas(handle, n, dLocal) {
  let nx = n.x, ny = n.y, nw = n.w, nh = n.h;
  switch (handle) {
    case 'n': ny += dLocal.y; nh -= dLocal.y; break;
    case 's': nh += dLocal.y; break;
    case 'w': nx += dLocal.x; nw -= dLocal.x; break;
    case 'e': nw += dLocal.x; break;
    case 'nw': nx += dLocal.x; ny += dLocal.y; nw -= dLocal.x; nh -= dLocal.y; break;
    case 'ne': ny += dLocal.y; nw += dLocal.x; nh -= dLocal.y; break;
    case 'sw': nx += dLocal.x; nw -= dLocal.x; nh += dLocal.y; break;
    case 'se': nw += dLocal.x; nh += dLocal.y; break;
  }
  if (state.aspectLocked && n.w > 0 && n.h > 0 && ['nw','ne','sw','se'].includes(handle)) {
    const ratio = Math.abs(n.w / n.h);
    if (Math.abs(nw) / Math.abs(nh) > ratio) {
      const tNw = Math.abs(nh) * ratio;
      if (handle.includes('w')) nx = n.x + n.w - Math.sign(nw || 1) * tNw;
      nw = Math.sign(nw || 1) * tNw;
    } else {
      const tNh = Math.abs(nw) / ratio;
      if (handle.includes('n')) ny = n.y + n.h - Math.sign(nh || 1) * tNh;
      nh = Math.sign(nh || 1) * tNh;
    }
  }
  if (nw < 0) { nx += nw; nw = -nw; }
  if (nh < 0) { ny += nh; nh = -nh; }
  return { nx, ny, nw, nh };
}
function computeFixedLocal(handle, n) {
  return {
    nw: { x: n.x + n.w, y: n.y + n.h }, n: { x: n.x + n.w/2, y: n.y + n.h },
    ne: { x: n.x, y: n.y + n.h }, w: { x: n.x + n.w, y: n.y + n.h/2 },
    e: { x: n.x, y: n.y + n.h/2 }, sw: { x: n.x + n.w, y: n.y },
    s: { x: n.x + n.w/2, y: n.y }, se: { x: n.x, y: n.y },
  }[handle];
}
function applyScaleToNodePoints(node, n, nx, ny, nw, nh) {
  if (node.type === 'powerclip') {
    if (node.container && n.container) scaleFromSnapshot(node.container, n.container, n, nx, ny, nw, nh);
    if (node.contents && n.contents) for (let i = 0; i < node.contents.length; i++)
      if (n.contents[i]) scaleFromSnapshot(node.contents[i], n.contents[i], n, nx, ny, nw, nh);
    return;
  }
  const sx = n.w > 0 ? nw / n.w : 1, sy = n.h > 0 ? nh / n.h : 1;
  if (node.subpaths && n.subpaths) {
    for (let si = 0; si < node.subpaths.length; si++)
      for (let ai = 0; ai < node.subpaths[si].anchors.length; ai++) {
        const orig = n.subpaths[si].anchors[ai], a = node.subpaths[si].anchors[ai];
        a.x = nx + (orig.x - n.x) * sx; a.y = ny + (orig.y - n.y) * sy;
        a.cIn.x = orig.cIn.x * sx; a.cIn.y = orig.cIn.y * sy;
        a.cOut.x = orig.cOut.x * sx; a.cOut.y = orig.cOut.y * sy;
      }
  } else if (node.anchors && n.anchors) {
    for (let ai = 0; ai < node.anchors.length; ai++) {
      const orig = n.anchors[ai];
      node.anchors[ai].x = nx + (orig.x - n.x) * sx;
      node.anchors[ai].y = ny + (orig.y - n.y) * sy;
      node.anchors[ai].cIn.x = orig.cIn.x * sx; node.anchors[ai].cIn.y = orig.cIn.y * sy;
      node.anchors[ai].cOut.x = orig.cOut.x * sx; node.anchors[ai].cOut.y = orig.cOut.y * sy;
    }
  }
}

function onPointerMove(e) {
  if (e.pointerId !== activePointerId || pinchState) return;
  const rect = getSceneRect();
  const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  if (state.pen.active) { onPenPointerMove(world); return; }
  const it = state.interaction;
  if (!it) return;

  if (!state.dragging && !['pan','marquee','draw','guide-create'].includes(it.type)) {
    state.dragging = true;
    state.draggingIds = new Set();
    if (it.type === 'move') for (const sn of it.startNodes) state.draggingIds.add(sn.id);
    else if (it.nodeId) state.draggingIds.add(it.nodeId);
    scheduleRender();
  }

  if (it.type === 'pan') {
    state.viewport.x = it.startVp.x + (e.clientX - it.startScreen.x);
    state.viewport.y = it.startVp.y + (e.clientY - it.startScreen.y);
    scheduleRender(); return;
  }
  if (it.type === 'guide-create') return;
  if (it.type === 'guide-drag') {
    const g = (state.doc.guides || []).find(x => x.id === it.guideId);
    if (!g) return;
    if (it.axis === 'v') g.pos = it.startPos + (world.x - it.startPointer.x);
    else g.pos = it.startPos + (world.y - it.startPointer.y);
    scheduleRender(); return;
  }
  if (it.type === 'crop-resize') {
    const dx = world.x - it.startPointer.x, dy = world.y - it.startPointer.y;
    const r = { ...it.startRect };
    if (it.handle.includes('w')) { r.x += dx; r.w -= dx; }
    if (it.handle.includes('e')) r.w += dx;
    if (it.handle.includes('n')) { r.y += dy; r.h -= dy; }
    if (it.handle.includes('s')) r.h += dy;
    if (r.w < 0) { r.x += r.w; r.w = -r.w; }
    if (r.h < 0) { r.y += r.h; r.h = -r.h; }
    const fb = state.cropping.fullBounds;
    r.x = Math.max(fb.x, Math.min(fb.x + fb.w - 10, r.x));
    r.y = Math.max(fb.y, Math.min(fb.y + fb.h - 10, r.y));
    r.w = Math.min(r.w, fb.x + fb.w - r.x);
    r.h = Math.min(r.h, fb.y + fb.h - r.y);
    state.cropping.cropRect = r;
    scheduleRender(); return;
  }
  if (it.type === 'crop-move') {
    const dx = world.x - it.startPointer.x, dy = world.y - it.startPointer.y;
    const r = { ...it.startRect };
    r.x += dx; r.y += dy;
    const fb = state.cropping.fullBounds;
    r.x = Math.max(fb.x, Math.min(fb.x + fb.w - r.w, r.x));
    r.y = Math.max(fb.y, Math.min(fb.y + fb.h - r.h, r.y));
    state.cropping.cropRect = r;
    scheduleRender(); return;
  }
  if (it.type === 'anchor-drag') {
    const node = getNode(it.nodeId);
    if (!node) return;
    const sp = getSubpaths(node)[it.subpathIndex];
    const a = sp && sp.anchors[it.anchorIndex];
    if (!a) return;
    a.x = it.startAnchor.x + (world.x - it.startPointer.x);
    a.y = it.startAnchor.y + (world.y - it.startPointer.y);
    scheduleRender(); return;
  }
  if (it.type === 'handle-drag') {
    const node = getNode(it.nodeId);
    if (!node) return;
    const sp = getSubpaths(node)[it.subpathIndex];
    const a = sp && sp.anchors[it.anchorIndex];
    if (!a) return;
    const dx = world.x - a.x, dy = world.y - a.y;
    if (it.side === 'out') {
      a.cOut = { x: dx, y: dy };
      if (it.symmetric) a.cIn = { x: -dx, y: -dy };
    } else {
      a.cIn = { x: dx, y: dy };
      if (it.symmetric) a.cOut = { x: -dx, y: -dy };
    }
    scheduleRender(); return;
  }
  if (it.type === 'move') {
    const dx = world.x - it.startPos.x, dy = world.y - it.startPos.y;
    for (const sn of it.startNodes) {
      const n = sn.ref || getNode(sn.id);
      if (!n) continue;
      n.x = sn.x + dx; n.y = sn.y + dy;
      if (sn.subpaths && n.subpaths) {
        for (let si = 0; si < n.subpaths.length; si++)
          for (let ai = 0; ai < n.subpaths[si].anchors.length; ai++) {
            n.subpaths[si].anchors[ai].x = sn.subpaths[si].anchors[ai].x + dx;
            n.subpaths[si].anchors[ai].y = sn.subpaths[si].anchors[ai].y + dy;
          }
      } else if (sn.anchors && n.anchors) {
        for (let i = 0; i < n.anchors.length; i++) {
          n.anchors[i].x = sn.anchors[i].x + dx;
          n.anchors[i].y = sn.anchors[i].y + dy;
        }
      }
    }
    for (const id of state.selection) {
      const top = getNode(id);
      if (top && top.type === 'powerclip' && top.container) {
        const cb = getNodeBounds(top.container);
        top.x = cb.x; top.y = cb.y; top.w = cb.w; top.h = cb.h;
      }
    }
    state.snapGuides = null;
    if (state.magnetEnabled) {
      const threshold = 10 / state.viewport.zoom;
      const selTop = [...state.selection].map(id => getTopLevelAncestor(id)).filter(Boolean);
      if (selTop.length) {
        let bounds;
        if (selTop.length === 1) bounds = getNodeBounds(selTop[0]);
        else {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const t of selTop) {
            const b = getNodeBounds(t);
            if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y;
            if (b.x + b.w > maxX) maxX = b.x + b.w; if (b.y + b.h > maxY) maxY = b.y + b.h;
          }
          bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
        const snap = computeSnapForBounds(bounds, state.selection, threshold);
        if (snap.dx !== 0 || snap.dy !== 0) {
          for (const sn of it.startNodes) {
            const n = sn.ref || getNode(sn.id);
            if (!n) continue;
            n.x += snap.dx; n.y += snap.dy;
            if (sn.subpaths && n.subpaths) {
              for (let si = 0; si < n.subpaths.length; si++)
                for (const a of n.subpaths[si].anchors) { a.x += snap.dx; a.y += snap.dy; }
            } else if (sn.anchors && n.anchors) {
              for (const a of n.anchors) { a.x += snap.dx; a.y += snap.dy; }
            }
          }
          state.snapGuides = snap;
        }
      }
    }
    scheduleRender(); schedulePanelUpdate(); return;
  }
  if (it.type === 'resize') {
    const n = it.startNode;
    const { cos, sin, cx, cy } = it;
    const delta = { x: world.x - it.startPointer.x, y: world.y - it.startPointer.y };
    const dLocal = { x: delta.x * cos + delta.y * sin, y: -delta.x * sin + delta.y * cos };
    const { nx, ny, nw, nh } = applyResizeDeltas(it.handle, n, dLocal);
    const ncx = nx + nw/2, ncy = ny + nh/2;
    const fl = computeFixedLocal(it.handle, n);
    const fwn = localToWorld(fl.x, fl.y, ncx, ncy, cos, sin);
    const fdx = it.fixedWorld.x - fwn.x, fdy = it.fixedWorld.y - fwn.y;
    const node = getNode(it.nodeId);
    if (node) {
      node.x = nx + fdx; node.y = ny + fdy; node.w = nw; node.h = nh;
      applyScaleToNodePoints(node, n, node.x, node.y, nw, nh);
    }
    scheduleRender(); schedulePanelUpdate(); return;
  }
  if (it.type === 'rotate') {
    const angle = Math.atan2(world.y - it.cy, world.x - it.cx);
    let rotation = (it.startRotation + (angle - it.startAngle) * 180 / Math.PI) % 360;
    if (rotation < 0) rotation += 360;
    const n = getNode(it.nodeId);
    if (n) n.rotation = rotation;
    scheduleRender(); schedulePanelUpdate(); return;
  }
  if (it.type === 'draw') {
    const n = getNode(it.id);
    if (!n) return;
    if (e.shiftKey) {
      const dx = world.x - it.start.x, dy = world.y - it.start.y;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      n.x = dx < 0 ? it.start.x - m : it.start.x;
      n.y = dy < 0 ? it.start.y - m : it.start.y;
      n.w = m; n.h = m;
    } else {
      n.x = Math.min(it.start.x, world.x); n.y = Math.min(it.start.y, world.y);
      n.w = Math.abs(world.x - it.start.x); n.h = Math.abs(world.y - it.start.y);
    }
    scheduleRender(); return;
  }
  if (it.type === 'marquee') {
    marqueeRect = { x1: it.start.x, y1: it.start.y, x2: world.x, y2: world.y };
    const mx1 = Math.min(it.start.x, world.x), mx2 = Math.max(it.start.x, world.x);
    const my1 = Math.min(it.start.y, world.y), my2 = Math.max(it.start.y, world.y);
    state.selection = new Set(it.additive ? it.originalSelection : []);
    for (const n of state.doc.nodes) {
      const b = getNodeBounds(n);
      if (b.x < mx2 && b.x + b.w > mx1 && b.y < my2 && b.y + b.h > my1) state.selection.add(n.id);
    }
    scheduleRender();
  }
}

function onPointerUp(e) {
  if (e.pointerId !== activePointerId) return;
  if (pointerAbort) { pointerAbort.abort(); pointerAbort = null; }
  activePointerId = null;
  if (state.pen.active) { onPenPointerUp(); scheduleRender(); return; }
  const it = state.interaction;

  if (it?.type === 'guide-create') {
    const sceneRect = getSceneRect();
    const mx = e.clientX - sceneRect.left;
    const my = e.clientY - sceneRect.top;
    if (it.axis === 'h' && my > 25) { const w = screenToWorld(mx, my); addGuide('h', w.y); }
    else if (it.axis === 'v' && mx > 25) { const w = screenToWorld(mx, my); addGuide('v', w.x); }
    endInteraction(); state.interaction = null;
    scheduleRender(); return;
  }
  if (it?.type === 'guide-drag') {
    const g = (state.doc.guides || []).find(x => x.id === it.guideId);
    if (g) {
      const sceneRect = getSceneRect();
      const gs = g.axis === 'v' ? g.pos * state.viewport.zoom + state.viewport.x : g.pos * state.viewport.zoom + state.viewport.y;
      if (gs < 25) removeGuide(g.id);
    }
    endInteraction(); state.interaction = null;
    scheduleRender(); return;
  }
  if (it?.type === 'crop-resize' || it?.type === 'crop-move') {
    endInteraction(); state.interaction = null;
    scheduleRender(); return;
  }
  if (it?.type === 'anchor-drag' || it?.type === 'handle-drag') {
    const node = getNode(it.nodeId);
    if (node) syncPathBounds(node);
    endInteraction(); state.interaction = null;
    state.dragging = false; state.draggingIds = null;
    scheduleRender(); updatePropertiesPanel(); return;
  }
  if (it?.type === 'draw') {
    const n = getNode(it.id);
    if (n) {
      if (n.w < 2 && n.h < 2) {
        if (it.tool === 'text') { n.w = 240; n.h = 60; }
        else { state.doc.nodes = state.doc.nodes.filter(x => x.id !== it.id); state.selection.clear(); }
      }
      if (it.tool === 'text' && state.selection.has(it.id)) {
        const isArea = n.w > 20 && n.h > 20;
        if (isArea) {
          n.textBox = true; n.text = 'Text';
          n.fontSize = Math.max(14, Math.min(48, Math.round(n.h * 0.25)));
          updatePropertiesPanel();
        } else {
          const txt = prompt('Enter text:', 'Text');
          if (txt === null) {
            const info = findNodeAndParent(it.id);
            if (info) info.list.splice(info.index, 1);
            state.selection.delete(it.id);
          } else {
            n.text = txt.trim() || 'Text';
            n.fontSize = 32;
            n.w = 240; n.h = 60;
          }
        }
      }
    }
  }
  if (it?.type === 'marquee') {
    marqueeRect = null;
    updatePropertiesPanel(); updateLayersPanel();
  }
  state.snapGuides = null;
  state.dragging = false; state.draggingIds = null;
  endInteraction(); state.interaction = null;
  scheduleRender();
  updateLayersPanel(); updatePropertiesPanel();
}

function enterPathEdit(nodeId) {
  const node = getNode(nodeId);
  if (!node || node.type !== 'path') return;
  state.pathEditing = nodeId;
  state.selectedAnchor = -1;
  setTool('select');
  scheduleRender();
  showToast('Edit mode — tap anchors');
}
function exitPathEdit() {
  if (!state.pathEditing) return;
  const node = getNode(state.pathEditing);
  if (node) syncPathBounds(node);
  state.pathEditing = null; state.selectedAnchor = -1;
  scheduleRender(); updatePropertiesPanel();
}

let lastTapInfo = { time: 0, x: 0, y: 0 };
scene.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse' || pinchState || state.tool === 'pen') return;
  if (state.cropping) return;
  const now = Date.now();
  if (now - lastTapInfo.time < 350 && Math.hypot(e.clientX - lastTapInfo.x, e.clientY - lastTapInfo.y) < 30) {
    handleDoubleActivation(e.clientX, e.clientY);
    lastTapInfo = { time: 0, x: 0, y: 0 };
  } else lastTapInfo = { time: now, x: e.clientX, y: e.clientY };
});
function onDblClick(e) {
  if (state.tool === 'pen') { if (state.pen.active) finishPenPath(); return; }
  if (state.cropping) return;
  handleDoubleActivation(e.clientX, e.clientY);
}
function handleDoubleActivation(clientX, clientY) {
  const rect = getSceneRect();
  const world = screenToWorld(clientX - rect.left, clientY - rect.top);
  let hitId = hitTest(world.x, world.y);
  if (!hitId) return;
  const node = getNode(hitId);
  if (!node) return;
  if (node.type === 'text') openTextEditor(node);
  else if (node.type === 'path') enterPathEdit(node.id);
  else if (node.type === 'powerclip') enterPowerClipEdit(node.id);
  else if (node.type === 'image') enterCropMode(node.id);
}
function openTextEditor(node) {
  const modal = document.getElementById('textEditModal');
  const ta = document.getElementById('textEditArea');
  ta.value = node.text || '';
  modal.classList.add('show');
  ta.focus(); ta.select();
  const close = (apply) => {
    modal.classList.remove('show');
    document.getElementById('btnTextEditOK').onclick = null;
    document.getElementById('btnTextEditCancel').onclick = null;
    if (apply) {
      commitChange(() => { node.text = ta.value; });
      scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
    }
  };
  document.getElementById('btnTextEditOK').onclick = () => close(true);
  document.getElementById('btnTextEditCancel').onclick = () => close(false);
}

/* ============ COLOR FIELDS ============ */
function bindColorField(colorId, hexId, onChange) {
  const colorEl = document.getElementById(colorId), hexEl = document.getElementById(hexId);
  if (!colorEl || !hexEl) return;
  colorEl.addEventListener('input', () => { hexEl.value = colorEl.value; onChange(colorEl.value); });
  hexEl.addEventListener('input', () => {
    let v = hexEl.value.trim();
    if (v.startsWith('#')) v = v.slice(1);
    if (/^[0-9a-fA-F]{6}$/.test(v)) {
      const hex = '#' + v.toLowerCase();
      colorEl.value = hex;
      onChange(hex);
    }
  });
  hexEl.addEventListener('blur', () => {
    if (colorEl.value && /^#[0-9a-fA-F]{6}$/.test(colorEl.value)) hexEl.value = colorEl.value.toLowerCase();
  });
}
function forEachSelected(fn) {
  const sel = [...state.selection].map(getNode).filter(Boolean);
  if (!sel.length) return false;
  if (propSnapshot === null) propSnapshot = JSON.stringify(state.doc);
  for (const n of sel) fn(n);
  return true;
}
bindColorField('fillColor', 'fillHex', (hex) => {
  if (!forEachSelected(n => {
    if (!n.style) n.style = {};
    if (typeof n.style.fill === 'string' || !n.style.fill) n.style.fill = hex;
    if (n.type === 'powerclip' && n.container) {
      if (!n.container.style) n.container.style = {};
      n.container.style.fill = hex;
    }
  })) return;
  scheduleRender(); schedulePropCommit();
});
bindColorField('strokeColor', 'strokeHex', (hex) => {
  if (!forEachSelected(n => {
    if (!n.style) n.style = {};
    n.style.stroke = hex;
    if (n.type === 'powerclip' && n.container) {
      if (!n.container.style) n.container.style = {};
      n.container.style.stroke = hex;
    }
  })) return;
  scheduleRender(); schedulePropCommit();
});
bindColorField('fxShadowColor', 'fxShadowHex', (hex) => {
  const sel = [...state.selection].map(getNode).filter(Boolean);
  if (!sel.length) return;
  const n = sel[0];
  if (!isSimpleNode(n)) return;
  if (propSnapshot === null) propSnapshot = JSON.stringify(state.doc);
  if (!n.effects) n.effects = {};
  if (!n.effects.shadow) n.effects.shadow = { on: false };
  n.effects.shadow.color = hex;
  scheduleRender(); schedulePropCommit();
});

/* ============ FILL MODE + GRADIENT ============ */
document.querySelectorAll('[data-fill-mode]').forEach(btn => {
  btn.addEventListener('click', () => setFillMode(btn.dataset.fillMode));
});
function setFillMode(mode) {
  if (!forEachSelected(n => {
    if (!n.style) n.style = {};
    const current = n.style.fill, isGrad = isGradientFill(current);
    if (mode === 'solid') {
      if (!isGrad) return;
      n.style.fill = current.stops?.[0]?.color || '#4ecdc4';
    } else {
      if (isGrad) return;
      const base = typeof current === 'string' ? current : '#4ecdc4';
      n.style.fill = { type: 'linear', angle: 0, stops: [{ offset: 0, color: base }, { offset: 1, color: invertColor(base) }] };
    }
  })) return;
  scheduleRender(); updatePropertiesPanel(); schedulePropCommit();
}
function renderGradientStops(node) {
  const container = document.getElementById('gradientStops');
  container.innerHTML = '';
  const fill = node.style?.fill;
  if (!isGradientFill(fill)) return;
  fill.stops.forEach((stop, i) => {
    const div = document.createElement('div');
    div.className = 'gradient-stop';
    const canRemove = fill.stops.length > 2;
    div.innerHTML = `<input type="color" class="stop-color" value="${stop.color}" data-index="${i}"><input type="text" class="stop-hex" value="${stop.color}" maxlength="7" data-index="${i}"><input type="number" class="stop-offset" value="${Math.round(stop.offset*100)}" min="0" max="100" step="1" data-index="${i}">${canRemove ? `<button class="stop-remove" data-index="${i}">×</button>` : ''}`;
    container.appendChild(div);
  });
  container.querySelectorAll('.stop-color').forEach(el => {
    el.addEventListener('input', () => {
      const i = parseInt(el.dataset.index);
      const hexEl = container.querySelector(`.stop-hex[data-index="${i}"]`);
      if (hexEl) hexEl.value = el.value;
      updateStopColor(i, el.value);
    });
  });
  container.querySelectorAll('.stop-hex').forEach(el => {
    el.addEventListener('input', () => {
      let v = el.value.trim(); if (v.startsWith('#')) v = v.slice(1);
      if (/^[0-9a-fA-F]{6}$/.test(v)) {
        const hex = '#' + v.toLowerCase();
        const i = parseInt(el.dataset.index);
        const colorEl = container.querySelector(`.stop-color[data-index="${i}"]`);
        if (colorEl) colorEl.value = hex;
        updateStopColor(i, hex);
      }
    });
    el.addEventListener('blur', () => {
      const i = parseInt(el.dataset.index);
      const colorEl = container.querySelector(`.stop-color[data-index="${i}"]`);
      if (colorEl) el.value = colorEl.value;
    });
  });
  container.querySelectorAll('.stop-offset').forEach(el => {
    el.addEventListener('input', () => {
      const i = parseInt(el.dataset.index);
      updateStopOffset(i, Math.max(0, Math.min(100, parseFloat(el.value) || 0)) / 100);
    });
  });
  container.querySelectorAll('.stop-remove').forEach(el => {
    el.addEventListener('click', () => removeGradientStop(parseInt(el.dataset.index)));
  });
}
function updateStopColor(index, color) {
  if (!forEachSelected(n => { if (isGradientFill(n.style?.fill) && n.style.fill.stops[index]) n.style.fill.stops[index].color = color; })) return;
  scheduleRender(); schedulePropCommit();
}
function updateStopOffset(index, offset) {
  if (!forEachSelected(n => { if (isGradientFill(n.style?.fill) && n.style.fill.stops[index]) n.style.fill.stops[index].offset = Math.max(0, Math.min(1, offset)); })) return;
  scheduleRender(); schedulePropCommit();
}
function removeGradientStop(index) {
  if (!forEachSelected(n => { if (isGradientFill(n.style?.fill) && n.style.fill.stops.length > 2) n.style.fill.stops.splice(index, 1); })) return;
  scheduleRender(); updatePropertiesPanel(); schedulePropCommit();
}
function addGradientStop() {
  if (!forEachSelected(n => {
    if (!isGradientFill(n.style?.fill)) return;
    const stops = n.style.fill.stops;
    const sorted = [...stops].sort((a,b) => a.offset - b.offset);
    let gs = 0, ge = 1;
    if (sorted.length >= 2) {
      let maxGap = 0;
      for (let i = 0; i < sorted.length - 1; i++) {
        const g = sorted[i+1].offset - sorted[i].offset;
        if (g > maxGap) { maxGap = g; gs = sorted[i].offset; ge = sorted[i+1].offset; }
      }
    }
    stops.push({ offset: (gs + ge) / 2, color: sorted[0]?.color || '#ff0000' });
  })) return;
  scheduleRender(); updatePropertiesPanel(); schedulePropCommit();
}
document.getElementById('btnAddStop').addEventListener('click', addGradientStop);
document.getElementById('gradientType').addEventListener('change', (e) => {
  if (!forEachSelected(n => { if (isGradientFill(n.style?.fill)) n.style.fill.type = e.target.value; })) return;
  document.getElementById('gradientAngleRow').style.display = e.target.value === 'radial' ? 'none' : '';
  scheduleRender(); schedulePropCommit();
});
document.getElementById('gradientAngle').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value) || 0;
  if (!forEachSelected(n => { if (isGradientFill(n.style?.fill)) n.style.fill.angle = v; })) return;
  scheduleRender(); schedulePropCommit();
});

/* ============ PROPERTY PANEL ============ */
function updatePropertiesPanel() {
  const sel = [...state.selection].map(getNode).filter(Boolean);
  const $ = (id) => document.getElementById(id);
  const boolSec = $('booleanSection'), pcSec = $('powerclipSection');
  boolSec.style.display = sel.length >= 2 ? '' : 'none';
  if (sel.length >= 2) {
    const allBool = sel.every(n => ['rect','ellipse','path'].includes(n.type));
    boolSec.querySelectorAll('[data-bool]').forEach(b => b.disabled = !allBool);
  }
  const showPC = sel.length >= 2 || (sel.length === 1 && sel[0].type === 'powerclip');
  pcSec.style.display = showPC ? '' : 'none';
  if (showPC) {
    const btn = $('btnPowerClipAction');
    if (state.editingPowerClip) { btn.textContent = '✓ Done editing'; btn.onclick = exitPowerClipEdit; }
    else if (sel.length === 1 && sel[0].type === 'powerclip') { btn.textContent = '✏️ Edit contents'; btn.onclick = () => enterPowerClipEdit(sel[0].id); }
    else if (sel.length >= 2) { btn.textContent = '📦 Create PowerClip'; btn.onclick = createPowerClip; }
  }

  const cornersSection = $('cornersSection'), textSection = $('textSection');
  const effectsSection = $('effectsSection'), pathActionsRow = $('pathActionsRow');
  const imageActionsRow = $('imageActionsRow');

  if (!sel.length) {
    ['propX','propY','propW','propH','propRot','propStrokeW','propOpacity'].forEach(id => { const el = $(id); if (el) el.value = ''; });
    $('fillHex').value = ''; $('strokeHex').value = '';
    cornersSection.style.display = 'none'; textSection.style.display = 'none';
    effectsSection.style.display = 'none'; pathActionsRow.style.display = 'none';
    imageActionsRow.style.display = 'none';
    updateShapeUI(); return;
  }

  const n = sel[0], b = getNodeBounds(n);
  $('propX').value = Math.round(b.x); $('propY').value = Math.round(b.y);
  $('propW').value = Math.round(b.w); $('propH').value = Math.round(b.h);
  $('propRot').value = Math.round(n.rotation || 0);
  $('propStrokeW').value = n.style?.strokeWidth || n.container?.style?.strokeWidth || 0;
  $('propOpacity').value = n.style?.opacity !== undefined ? n.style.opacity : 1;

  const fillValue = n.style?.fill, isGrad = isGradientFill(fillValue);
  document.querySelectorAll('[data-fill-mode]').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.fillMode === 'linear' && isGrad) || (btn.dataset.fillMode === 'solid' && !isGrad));
  });
  $('fillSolidRow').style.display = isGrad ? 'none' : '';
  $('fillGradientRow').style.display = isGrad ? '' : 'none';
  if (isGrad) {
    $('gradientType').value = fillValue.type || 'linear';
    $('gradientAngleRow').style.display = fillValue.type === 'radial' ? 'none' : '';
    $('gradientAngle').value = fillValue.angle || 0;
    renderGradientStops(n);
  } else {
    const hex = typeof fillValue === 'string' ? normalizeHex(fillValue) : '#000000';
    $('fillColor').value = hex; $('fillHex').value = hex;
  }
  const strokeHex = normalizeHex(n.style?.stroke || '#2a2a2a');
  $('strokeColor').value = strokeHex; $('strokeHex').value = strokeHex;

  if (sel.length === 1 && isSimpleNode(n)) {
    effectsSection.style.display = '';
    const fx = n.effects || {}, sh = fx.shadow || {}, bl = fx.blur || {};
    $('fxShadowOn').checked = !!sh.on;
    $('fxShadowX').value = sh.x ?? 4; $('fxShadowY').value = sh.y ?? 4;
    $('fxShadowBlur').value = sh.blur ?? 8;
    const shColor = normalizeHex((sh.color || '#000000').slice(0, 7));
    $('fxShadowColor').value = shColor; $('fxShadowHex').value = shColor;
    $('fxBlurOn').checked = !!bl.on;
    $('fxBlurRadius').value = bl.radius ?? 4;
  } else effectsSection.style.display = 'none';

  cornersSection.style.display = sel.some(x => x.type === 'rect') ? '' : 'none';
  if (sel.some(x => x.type === 'rect')) updateCornerRadiusUI();

  const texts = sel.filter(x => x.type === 'text');
  if (texts.length) {
    textSection.style.display = '';
    const tn = texts[0];
    $('propText').value = tn.text || '';
    $('propFontSize').value = tn.fontSize || 32;
    $('propTextBox').checked = !!tn.textBox;
    $('propTextAlign').value = tn.align || 'left';
  } else textSection.style.display = 'none';

  imageActionsRow.style.display = sel.some(x => x.type === 'image') ? '' : 'none';

  const paths = sel.filter(x => x.type === 'path');
  const convertible = sel.filter(x => ['rect','ellipse','line'].includes(x.type));
  if (paths.length && sel.length === 1) {
    pathActionsRow.style.display = '';
    $('btnConvertPath').style.display = 'none';
    $('btnEditPath').style.display = '';
  } else if (convertible.length && paths.length === 0) {
    pathActionsRow.style.display = '';
    $('btnConvertPath').style.display = '';
    $('btnEditPath').style.display = 'none';
  } else pathActionsRow.style.display = 'none';

  updateShapeUI();
}
function updateShapeUI() {
  const btnLock = document.getElementById('btnAspectLock');
  btnLock.textContent = state.aspectLocked ? '🔒' : '🔓';
  btnLock.classList.toggle('locked', state.aspectLocked);
}
document.getElementById('btnAspectLock').addEventListener('click', () => {
  state.aspectLocked = !state.aspectLocked;
  updateShapeUI();
  showToast(state.aspectLocked ? '🔒 Locked' : '🔓 Free');
});
document.getElementById('btnConvertPath').addEventListener('click', () => {
  const sel = [...state.selection].map(getNode).filter(Boolean);
  const convertible = sel.filter(x => ['rect','ellipse','line'].includes(x.type));
  if (!convertible.length) return;
  for (const n of convertible) convertNodeToPath(n.id);
});
document.getElementById('btnEditPath').addEventListener('click', () => {
  const sel = [...state.selection].map(getNode).filter(Boolean);
  const path = sel.find(x => x.type === 'path');
  if (!path) return;
  if (state.pathEditing === path.id) exitPathEdit();
  else enterPathEdit(path.id);
});
document.getElementById('btnCropImage').addEventListener('click', () => {
  const sel = [...state.selection].map(getNode).filter(x => x && x.type === 'image');
  if (sel[0]) enterCropMode(sel[0].id);
});
function updateEffectsFromInputs() {
  const sel = [...state.selection].map(getNode).filter(Boolean);
  if (!sel.length) return;
  const n = sel[0];
  if (!isSimpleNode(n)) return;
  if (propSnapshot === null) propSnapshot = JSON.stringify(state.doc);
  if (!n.effects) n.effects = {};
  n.effects.shadow = {
    on: document.getElementById('fxShadowOn').checked,
    x: parseFloat(document.getElementById('fxShadowX').value) || 0,
    y: parseFloat(document.getElementById('fxShadowY').value) || 0,
    blur: parseFloat(document.getElementById('fxShadowBlur').value) || 0,
    color: document.getElementById('fxShadowColor').value,
  };
  n.effects.blur = {
    on: document.getElementById('fxBlurOn').checked,
    radius: parseFloat(document.getElementById('fxBlurRadius').value) || 0,
  };
  scheduleRender(); schedulePropCommit();
}
['fxShadowOn','fxShadowX','fxShadowY','fxShadowBlur','fxBlurOn','fxBlurRadius'].forEach(id => {
  const el = document.getElementById(id);
  if (el) { el.addEventListener('input', updateEffectsFromInputs); el.addEventListener('change', updateEffectsFromInputs); }
});
function updateCornerRadiusUI() {
  const sel = [...state.selection].map(getNode).filter(x => x && x.type === 'rect');
  if (!sel.length) return;
  const mode = document.getElementById('propCornerMode').value;
  const c = sel[0].corners || { tl: 0, tr: 0, br: 0, bl: 0 };
  document.getElementById('propCornerRadius').value = mode === 'all' ? Math.max(c.tl||0, c.tr||0, c.br||0, c.bl||0) : (c[mode] || 0);
}
document.getElementById('propCornerMode').addEventListener('change', updateCornerRadiusUI);
document.getElementById('propCornerRadius').addEventListener('input', (e) => {
  const val = Math.max(0, parseFloat(e.target.value) || 0);
  const mode = document.getElementById('propCornerMode').value;
  const sel = [...state.selection].map(getNode).filter(x => x && x.type === 'rect');
  if (!sel.length) return;
  if (propSnapshot === null) propSnapshot = JSON.stringify(state.doc);
  for (const n of sel) {
    if (!n.corners) n.corners = { tl: 0, tr: 0, br: 0, bl: 0 };
    if (mode === 'all') n.corners = { tl: val, tr: val, br: val, bl: val };
    else n.corners[mode] = val;
  }
  scheduleRender(); schedulePropCommit();
});
document.getElementById('propText').addEventListener('input', (e) => {
  const sel = [...state.selection].map(getNode).filter(x => x && x.type === 'text');
  if (!sel.length) return;
  if (propSnapshot === null) propSnapshot = JSON.stringify(state.doc);
  for (const n of sel) n.text = e.target.value;
  scheduleRender(); schedulePropCommit();
});
document.getElementById('propTextBox').addEventListener('change', (e) => {
  const sel = [...state.selection].map(getNode).filter(x => x && x.type === 'text');
  if (!sel.length) return;
  if (propSnapshot === null) propSnapshot = JSON.stringify(state.doc);
  for (const n of sel) n.textBox = e.target.checked;
  scheduleRender(); schedulePropCommit();
});
document.getElementById('propTextAlign').addEventListener('change', (e) => {
  const sel = [...state.selection].map(getNode).filter(x => x && x.type === 'text');
  if (!sel.length) return;
  if (propSnapshot === null) propSnapshot = JSON.stringify(state.doc);
  for (const n of sel) n.align = e.target.value;
  scheduleRender(); schedulePropCommit();
});
document.getElementById('propFontSize').addEventListener('input', (e) => {
  const f = parseFloat(e.target.value);
  if (isNaN(f) || f <= 0) return;
  const sel = [...state.selection].map(getNode).filter(x => x && x.type === 'text');
  if (!sel.length) return;
  if (propSnapshot === null) propSnapshot = JSON.stringify(state.doc);
  for (const n of sel) n.fontSize = f;
  scheduleRender(); schedulePropCommit();
});

const PROP_BINDINGS = {
  propX: (n, f) => { const dx = f - n.x; n.x = f; eachPoint(n, p => p.x += dx); },
  propY: (n, f) => { const dy = f - n.y; n.y = f; eachPoint(n, p => p.y += dy); },
  propW: (n, f) => {
    const sx = n.w > 0 ? f / n.w : 1;
    if (n.subpaths) for (const sp of n.subpaths) for (const a of sp.anchors) { a.x = n.x + (a.x - n.x) * sx; a.cIn.x *= sx; a.cOut.x *= sx; }
    else if (n.anchors) for (const a of n.anchors) { a.x = n.x + (a.x - n.x) * sx; a.cIn.x *= sx; a.cOut.x *= sx; }
    n.w = f;
  },
  propH: (n, f) => {
    const sy = n.h > 0 ? f / n.h : 1;
    if (n.subpaths) for (const sp of n.subpaths) for (const a of sp.anchors) { a.y = n.y + (a.y - n.y) * sy; a.cIn.y *= sy; a.cOut.y *= sy; }
    else if (n.anchors) for (const a of n.anchors) { a.y = n.y + (a.y - n.y) * sy; a.cIn.y *= sy; a.cOut.y *= sy; }
    n.h = f;
  },
  propRot: (n, f) => { n.rotation = f; },
  propStrokeW: (n, f) => {
    if (!n.style) n.style = {};
    n.style.strokeWidth = f;
    if (n.type === 'powerclip' && n.container) {
      if (!n.container.style) n.container.style = {};
      n.container.style.strokeWidth = f;
    }
  },
  propOpacity: (n, f) => { if (!n.style) n.style = {}; n.style.opacity = Math.max(0, Math.min(1, f)); },
};
Object.entries(PROP_BINDINGS).forEach(([id, fn]) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', (e) => {
    const sel = [...state.selection].map(getNode).filter(Boolean);
    if (!sel.length) return;
    if (propSnapshot === null) propSnapshot = JSON.stringify(state.doc);
    for (const n of sel) {
      if (n.type === 'group') continue;
      const v = parseFloat(e.target.value);
      if (isNaN(v)) continue;
      if ((id === 'propW' || id === 'propH') && v <= 0) continue;
      fn(n, v);
    }
    scheduleRender(); updateLayersPanel(); schedulePropCommit();
  });
});

/* ============ CANVAS SIZE ============ */
function updateCanvasSizeUI() {
  document.getElementById('canvasW').value = state.doc.canvasW;
  document.getElementById('canvasH').value = state.doc.canvasH;
}
[['canvasW','canvasW'], ['canvasH','canvasH']].forEach(([id, key]) => {
  document.getElementById(id).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (isNaN(v) || v < 10) return;
    if (propSnapshot === null) propSnapshot = JSON.stringify(state.doc);
    state.doc[key] = v;
    scheduleRender(); schedulePropCommit();
  });
});

/* ============ LAYERS ============ */
function updateLayersPanel() {
  const list = document.getElementById('layersList');
  const parts = [];
  function walk(nodes, depth) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const sel = state.selection.has(n.id) ? 'selected' : '';
      const isGroup = n.type === 'group', isPC = n.type === 'powerclip';
      const isEditing = state.editingPowerClip === n.id;
      const cls = `layer-item ${sel} ${isGroup ? 'group' : ''} ${isPC ? 'powerclip' : ''} ${isEditing ? 'editing' : ''}`;
      parts.push(`<div class="${cls}" data-layer-id="${n.id}" style="padding-left:${10 + depth * 14}px"><span class="layer-name">${escapeHtml(getNodeName(n))}</span><span class="badge">${isPC ? 'PC' : n.type}</span></div>`);
      if (isGroup && n.children) walk(n.children, depth + 1);
    }
  }
  if (state.doc.nodes.length === 0) { list.innerHTML = '<div class="empty-state">No layers yet</div>'; updateLayerActionButtons(); return; }
  walk(state.doc.nodes, 0);
  list.innerHTML = parts.join('');
  list.querySelectorAll('.layer-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const id = item.dataset.layerId;
      if (e.shiftKey) {
        if (state.selection.has(id)) state.selection.delete(id);
        else state.selection.add(id);
      } else state.selection = new Set([id]);
      scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
    });
    const nameEl = item.querySelector('.layer-name');
    if (nameEl) {
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const node = getNode(item.dataset.layerId);
        if (!node) return;
        const newName = prompt('Rename layer:', getNodeName(node));
        if (newName !== null) {
          commitChange(() => { node.name = newName.trim() || capitalize(node.type); });
          updateLayersPanel();
        }
      });
    }
  });
  updateLayerActionButtons();
}
function updateLayerActionButtons() {
  const n = state.selection.size;
  document.getElementById('btnLayerMerge').disabled = n < 2;
  document.getElementById('btnLayerUngroup').disabled = n < 1 || ![...state.selection].some(id => {
    const node = getNode(id); return node && (node.type === 'group' || node.type === 'powerclip');
  });
  document.getElementById('btnLayerMoveInto').disabled = n < 1;
  document.getElementById('btnLayerUp').disabled = n !== 1;
  document.getElementById('btnLayerDown').disabled = n !== 1;
  document.getElementById('btnLayerDelete').disabled = n < 1;
}
function moveLayer(dir) {
  if (state.selection.size !== 1) return;
  const info = findNodeAndParent([...state.selection][0]);
  if (!info) return;
  const { list, index } = info;
  const target = dir > 0 ? index + 1 : index - 1;
  if (target < 0 || target >= list.length) return;
  commitChange(() => { [list[index], list[target]] = [list[target], list[index]]; });
  scheduleRender(); updateLayersPanel();
}
function mergeSelected() {
  const topIds = new Set();
  for (const id of state.selection) { const top = getTopLevelAncestor(id); if (top) topIds.add(top.id); }
  if (topIds.size < 2) return;
  commitChange(() => {
    const toMerge = [];
    for (let i = state.doc.nodes.length - 1; i >= 0; i--) if (topIds.has(state.doc.nodes[i].id)) toMerge.unshift(state.doc.nodes.splice(i, 1)[0]);
    const group = { id: genId(), type: 'group', name: 'Group', children: toMerge };
    state.doc.nodes.push(group);
    state.selection = new Set([group.id]);
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
}
function ungroupSelected() {
  const targets = [...state.selection].map(getNode).filter(n => n && (n.type === 'group' || n.type === 'powerclip'));
  if (!targets.length) return;
  commitChange(() => {
    const newSel = new Set();
    for (const id of state.selection) {
      const info = findNodeAndParent(id);
      if (!info) continue;
      const { node, list, index } = info;
      const toInsert = node.type === 'group' ? (node.children || []) : [node.container, ...(node.contents || [])].filter(Boolean);
      list.splice(index, 1, ...toInsert);
      for (const n2 of toInsert) newSel.add(n2.id);
    }
    state.selection = newSel;
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
}
function deleteSelected() {
  if (!state.selection.size) return;
  if (state.editingPowerClip) exitPowerClipEdit();
  if (state.cropping) state.cropping = null;
  commitChange(() => {
    for (const id of state.selection) {
      const info = findNodeAndParent(id);
      if (info) info.list.splice(info.index, 1);
    }
    state.selection.clear();
  });
  if (state.pathEditing && !getNode(state.pathEditing)) { state.pathEditing = null; state.selectedAnchor = -1; }
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
}
function removeFromTree(nodes, ids, collected) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (ids.has(nodes[i].id)) collected.unshift(nodes.splice(i, 1)[0]);
    else if (nodes[i].type === 'group' && nodes[i].children) removeFromTree(nodes[i].children, ids, collected);
  }
}
function moveSelectionInto(targetId) {
  const target = getNode(targetId);
  if (!target || target.type !== 'group') return;
  const topIds = new Set();
  for (const id of state.selection) {
    const top = getTopLevelAncestor(id);
    if (!top || top.id === targetId || isDescendant(top.id, targetId)) continue;
    topIds.add(top.id);
  }
  if (!topIds.size) { showToast('Cannot move'); return; }
  commitChange(() => {
    const toMove = [];
    removeFromTree(state.doc.nodes, topIds, toMove);
    if (!target.children) target.children = [];
    target.children.push(...toMove);
    state.selection = new Set([targetId]);
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('Moved into ' + getNodeName(target));
}
function moveSelectionToNewContainer() {
  const topIds = new Set();
  for (const id of state.selection) { const top = getTopLevelAncestor(id); if (top) topIds.add(top.id); }
  if (!topIds.size) return;
  commitChange(() => {
    const toMove = [];
    removeFromTree(state.doc.nodes, topIds, toMove);
    const group = { id: genId(), type: 'group', name: 'Container', children: toMove };
    state.doc.nodes.push(group);
    state.selection = new Set([group.id]);
  });
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('New container');
}
function showMoveIntoMenu(anchor) {
  closeAllMenus();
  const menu = document.createElement('div');
  menu.className = 'export-menu';
  const items = [{ label: '📦 New container', action: moveSelectionToNewContainer }];
  const groups = [];
  function walk(nodes, depth) {
    for (const n of nodes) {
      if (n.type === 'group') { groups.push({ node: n, depth }); if (n.children) walk(n.children, depth + 1); }
    }
  }
  walk(state.doc.nodes, 0);
  if (groups.length) {
    items.push({ label: '___SEP___', action: null });
    items.push({ label: 'Existing:', action: null, isLabel: true });
    for (const { node, depth } of groups) items.push({ label: '📂 ' + getNodeName(node), action: () => moveSelectionInto(node.id), indent: depth });
  }
  menu.innerHTML = items.map((item, i) => {
    if (item.label === '___SEP___') return '<div class="menu-sep"></div>';
    if (item.isLabel) return `<div class="menu-label">${item.label}</div>`;
    const style = item.indent ? `padding-left:${16 + item.indent * 12}px` : '';
    return `<button data-i="${i}" style="${style}">${escapeHtml(item.label)}</button>`;
  }).join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect(), mh = menu.offsetHeight;
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8));
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
  menu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = items[parseInt(btn.dataset.i)];
      menu.remove();
      if (item && item.action) item.action();
    });
  });
}
document.getElementById('btnLayerMerge').addEventListener('click', mergeSelected);
document.getElementById('btnLayerUngroup').addEventListener('click', ungroupSelected);
document.getElementById('btnLayerMoveInto').addEventListener('click', (e) => { e.stopPropagation(); showMoveIntoMenu(e.currentTarget); });
document.getElementById('btnLayerUp').addEventListener('click', () => moveLayer(1));
document.getElementById('btnLayerDown').addEventListener('click', () => moveLayer(-1));
document.getElementById('btnLayerDelete').addEventListener('click', deleteSelected);

/* ============ TOOLS ============ */
function setTool(tool) {
  if (state.pen.active && tool !== 'pen') finishPenPath();
  if (state.pathEditing && tool !== 'select') exitPathEdit();
  if (state.editingPowerClip && tool !== 'select') exitPowerClipEdit();
  if (state.cropping && tool !== 'select') cancelCrop();
  state.tool = tool;
  document.querySelectorAll('.tools button').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  canvasArea.style.cursor = tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
  updateFloatingToolbar();
}
document.querySelectorAll('.tools button').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

let rectHoldTimer = null, rectHoldFired = false;
const rectToolBtn = document.querySelector('.tools button[data-tool="rect"]');
rectToolBtn.addEventListener('pointerdown', () => {
  rectHoldFired = false;
  rectToolBtn.classList.add('holding');
  rectHoldTimer = setTimeout(() => {
    rectHoldFired = true;
    rectToolBtn.classList.remove('holding');
    createFullCanvasRect();
    if (navigator.vibrate) navigator.vibrate(30);
  }, 2000);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach(evt => {
  rectToolBtn.addEventListener(evt, () => { clearTimeout(rectHoldTimer); rectToolBtn.classList.remove('holding'); });
});
rectToolBtn.addEventListener('click', (e) => {
  if (rectHoldFired) { rectHoldFired = false; e.stopImmediatePropagation(); e.preventDefault(); }
}, true);
function createFullCanvasRect() {
  commitChange(() => {
    const node = { id: genId(), type: 'rect', name: 'Canvas Cover',
      x: 0, y: 0, w: state.doc.canvasW, h: state.doc.canvasH, rotation: 0,
      corners: { tl: 0, tr: 0, br: 0, bl: 0 },
      style: { fill: '#c8e6ff', stroke: '#0af', strokeWidth: 2, opacity: 1 } };
    state.doc.nodes.push(node);
    state.selection = new Set([node.id]);
  });
  setTool('select');
  scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
  showToast('Canvas rectangle created');
}
const btnMagnet = document.getElementById('btnMagnet');
btnMagnet.addEventListener('click', () => {
  state.magnetEnabled = !state.magnetEnabled;
  btnMagnet.classList.toggle('magnet-on', state.magnetEnabled);
  showToast(state.magnetEnabled ? '🧲 ON' : 'OFF');
});

/* ============ ZOOM ============ */
function onWheel(e) {
  e.preventDefault();
  const rect = getSceneRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const before = screenToWorld(px, py);
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  state.viewport.zoom = Math.max(0.05, Math.min(20, state.viewport.zoom * factor));
  state.viewport.x = px - before.x * state.viewport.zoom;
  state.viewport.y = py - before.y * state.viewport.zoom;
  scheduleRender(); updateZoomLabel();
}
function updateZoomLabel() {
  document.getElementById('zoomLabel').textContent = Math.round(state.viewport.zoom * 100) + '%';
}
function fitToView() {
  const rect = canvasArea.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const zoom = Math.min((rect.width - 30) / state.doc.canvasW, (rect.height - 30) / state.doc.canvasH) * 0.9;
  state.viewport.zoom = zoom;
  state.viewport.x = (rect.width - 22 - state.doc.canvasW * zoom) / 2;
  state.viewport.y = (rect.height - 22 - state.doc.canvasH * zoom) / 2;
  render(); renderOverlay(); updateZoomLabel();
}

/* ============ FILE I/O ============ */
async function saveWithPicker(data, filename, mimeType, ext) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: ext.toUpperCase() + ' file', accept: { [mimeType]: ['.' + ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      showToast('✅ ' + handle.name);
      return true;
    } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  showToast('⬇ ' + filename);
  return true;
}
async function saveJSON() {
  const json = JSON.stringify(state.doc, null, 2);
  const stamp = new Date().toISOString().slice(0,10);
  await saveWithPicker(json, `design-${stamp}.json`, 'application/json', 'json');
}
async function loadJSON() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        multiple: false,
      });
      const file = await handle.getFile();
      loadDocFromText(await file.text());
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadDocFromText(reader.result);
    reader.readAsText(file);
  };
  input.click();
}
function migrateDoc(doc) {
  if (!doc.guides) doc.guides = [];
  function migrate(nodes) {
    for (const n of nodes) {
      if (n.type === 'path') ensureSubpaths(n);
      if (n.type === 'group' && n.children) migrate(n.children);
      if (n.type === 'powerclip') {
        if (n.container) migrate([n.container]);
        if (n.contents) migrate(n.contents);
      }
      if (n.attachedPath && n.attachedPath.subpaths) {
        for (const sp of n.attachedPath.subpaths) for (const a of sp.anchors) {
          if (!a.cIn) a.cIn = { x: 0, y: 0 };
          if (!a.cOut) a.cOut = { x: 0, y: 0 };
        }
      }
    }
  }
  if (doc.nodes) migrate(doc.nodes);
  return doc;
}
function loadDocFromText(text) {
  try {
    const doc = JSON.parse(text);
    if (!doc.nodes || !Array.isArray(doc.nodes)) throw new Error('bad format');
    migrateDoc(doc);
    path2dCache.clear(); imageCache.clear();
    commitChange(() => { state.doc = doc; state.selection.clear(); });
    resetAfterHistory();
    render(); renderOverlay();
    updateLayersPanel(); updatePropertiesPanel(); updateCanvasSizeUI(); fitToView();
    showToast('✅ Loaded');
  } catch (err) { alert('Invalid file: ' + err.message); }
}
async function exportSVG() { await saveWithPicker(docToSVGString(), 'design.svg', 'image/svg+xml', 'svg'); }
async function exportPNG() {
  const svgBlob = new Blob([docToSVGString()], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = state.doc.canvasW; canvas.height = state.doc.canvasH;
    canvas.getContext('2d').drawImage(img, 0, 0);
    canvas.toBlob(async (blob) => {
      URL.revokeObjectURL(url);
      await saveWithPicker(blob, 'design.png', 'image/png', 'png');
    }, 'image/png');
  };
  img.onerror = () => { alert('PNG export failed'); URL.revokeObjectURL(url); };
  img.src = url;
}
function importImage() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result;
      const img = new Image();
      img.onload = () => {
        const w = img.width || 300, h = img.height || 300;
        const maxW = state.doc.canvasW * 0.6, maxH = state.doc.canvasH * 0.6;
        const scale = Math.min(maxW / w, maxH / h, 1);
        const nw = w * scale, nh = h * scale;
        const node = { id: genId(), type: 'image',
          x: (state.doc.canvasW - nw) / 2, y: (state.doc.canvasH - nh) / 2,
          w: nw, h: nh, rotation: 0, src, style: { opacity: 1 },
          name: file.name.replace(/\.[^.]+$/, '') };
        commitChange(() => { state.doc.nodes.push(node); state.selection = new Set([node.id]); });
        scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
        showToast('✅ Imported');
      };
      img.onerror = () => alert('Failed to load image');
      img.src = src;
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

function nodeToSVG(n) {
  const { x, y, w, h, rotation, style, type } = n;
  const cx = x + w/2, cy = y + h/2;
  const tf = rotation ? `rotate(${rotation} ${cx} ${cy})` : '';
  const fillCss = getFillCss(style, n.id);
  const stroke = style?.stroke || 'none';
  const sw = style?.strokeWidth || 0;
  const op = style?.opacity !== undefined ? style.opacity : 1;

  if (type === 'group') return `<g data-id="${n.id}">${n.children.map(nodeToSVG).join('')}</g>`;
  if (type === 'powerclip') {
    const cid = `clip-${n.id}`;
    let clipContent = '';
    const c = n.container;
    if (c) {
      if (c.type === 'rect') {
        const corners = c.corners || {};
        clipContent = (corners.tl || corners.tr || corners.br || corners.bl)
          ? `<path d="${roundedRectPath(c.x, c.y, c.w, c.h, corners)}"/>`
          : `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}"/>`;
      } else if (c.type === 'ellipse') clipContent = `<ellipse cx="${c.x+c.w/2}" cy="${c.y+c.h/2}" rx="${c.w/2}" ry="${c.h/2}"/>`;
      else if (c.type === 'path') clipContent = `<path d="${getPathD(c)}"/>`;
      else { const b = getNodeBounds(c); clipContent = `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`; }
    }
    const contentsSvg = (n.contents || []).map(nodeToSVG).join('');
    const containerSvg = c ? nodeToSVG(c) : '';
    return `<g data-id="${n.id}"><defs><clipPath id="${cid}" clipPathUnits="userSpaceOnUse">${clipContent}</clipPath></defs><g clip-path="url(#${cid})">${contentsSvg}</g>${containerSvg}</g>`;
  }
  let inner = '';
  if (type === 'rect') {
    const c = n.corners || { tl: 0, tr: 0, br: 0, bl: 0 };
    inner = (c.tl || c.tr || c.br || c.bl)
      ? `<path d="${roundedRectPath(x, y, Math.abs(w), Math.abs(h), c)}" fill="${fillCss}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`
      : `<rect x="${x}" y="${y}" width="${Math.abs(w)}" height="${Math.abs(h)}" fill="${fillCss}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`;
  } else if (type === 'ellipse') {
    inner = `<ellipse cx="${cx}" cy="${cy}" rx="${Math.abs(w)/2}" ry="${Math.abs(h)/2}" fill="${fillCss}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`;
  } else if (type === 'line') {
    inner = `<line x1="${x}" y1="${y}" x2="${x+w}" y2="${y+h}" stroke="${style?.stroke || '#2a2a2a'}" stroke-width="${sw || 2}" opacity="${op}" stroke-linecap="round"/>`;
  } else if (type === 'text') {
    const fs = n.fontSize || 32;
    if (n.attachedPath) {
      inner = `<text x="${x}" y="${y + fs}" font-size="${fs}" fill="${fillCss}" font-family="system-ui">${escapeHtml(n.text || '')}</text>`;
    } else {
      const lh = (n.lineHeight || 1.2) * fs;
      const lines = (n.text || '').split('\n');
      const tspans = lines.map((line, i) => `<tspan x="${x}" dy="${i === 0 ? fs : lh}">${escapeHtml(line)}</tspan>`).join('');
      inner = `<text x="${x}" y="${y}" font-size="${fs}" fill="${fillCss}" stroke="${sw > 0 ? stroke : 'none'}" stroke-width="${sw}" opacity="${op}" font-family="system-ui" xml:space="preserve">${tspans}</text>`;
    }
  } else if (type === 'image') {
    const crop = n.crop;
    if (crop) {
      const fullW = Math.abs(w) / crop.w;
      const fullH = Math.abs(h) / crop.h;
      const fullX = x - crop.x * fullW;
      const fullY = y - crop.y * fullH;
      const cid = `crop-${n.id}`;
      inner = `<defs><clipPath id="${cid}"><rect x="${x}" y="${y}" width="${Math.abs(w)}" height="${Math.abs(h)}"/></clipPath></defs><image href="${n.src}" x="${fullX}" y="${fullY}" width="${fullW}" height="${fullH}" preserveAspectRatio="none" opacity="${op}" clip-path="url(#${cid})"/>`;
    } else {
      inner = `<image href="${n.src}" x="${x}" y="${y}" width="${Math.abs(w)}" height="${Math.abs(h)}" preserveAspectRatio="none" opacity="${op}"/>`;
    }
  } else if (type === 'path') {
    const d = getPathD(n);
    const pathFill = getSubpaths(n).some(sp => sp.closed) ? fillCss : 'none';
    const fillRule = n.fillRule ? `fill-rule="${n.fillRule}"` : '';
    inner = `<path d="${d}" fill="${pathFill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}" stroke-linejoin="round" ${fillRule}/>`;
  }
  const filterAttr = hasEffects(n) ? ` filter="url(#fx-${n.id})"` : '';
  return `<g data-id="${n.id}" transform="${tf}" style="cursor:pointer"${filterAttr}>${inner}</g>`;
}
function docToSVGString() {
  const filters = state.doc.nodes.map(buildFilterDef).filter(Boolean).join('');
  const gradients = state.doc.nodes.map(buildGradientDef).filter(Boolean).join('');
  const nodes = state.doc.nodes.map(nodeToSVG).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${state.doc.canvasW}" height="${state.doc.canvasH}" viewBox="0 0 ${state.doc.canvasW} ${state.doc.canvasH}"><defs>${filters}${gradients}</defs><rect width="${state.doc.canvasW}" height="${state.doc.canvasH}" fill="white"/>${nodes}</svg>`;
}

/* ============ FILE MENU ============ */
function closeAllMenus() {
  if (fileMenuEl) { fileMenuEl.remove(); fileMenuEl = null; }
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
  document.querySelectorAll('.export-menu').forEach(m => m.remove());
}
document.getElementById('btnFileMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  if (fileMenuEl) { closeAllMenus(); return; }
  closeAllMenus();
  const menu = document.createElement('div');
  menu.className = 'export-menu';
  menu.innerHTML = `<button data-action="save">💾 Save</button><button data-action="open">📂 Open</button><button data-action="import">🖼 Import Image</button><button data-action="import-svg">🎨 Import SVG</button><div class="menu-sep"></div><button data-action="export-svg">⤓ Export SVG</button><button data-action="export-png">⤓ Export PNG</button><div class="menu-sep"></div><button data-action="clear-autosave">🗑 Clear autosave</button>`;
  document.body.appendChild(menu);
  fileMenuEl = menu;
  const r = e.currentTarget.getBoundingClientRect();
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 4);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8));
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
  menu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      closeAllMenus();
      if (action === 'save') saveJSON();
      else if (action === 'open') loadJSON();
      else if (action === 'import') importImage();
      else if (action === 'import-svg') importSVG();
      else if (action === 'export-svg') exportSVG();
      else if (action === 'export-png') exportPNG();
      else if (action === 'clear-autosave') {
        clearAutosave().then(() => { updateAutosaveIndicator('idle'); showToast('Autosave cleared'); });
      }
    });
  });
});
document.addEventListener('click', (e) => {
  if (fileMenuEl && !fileMenuEl.contains(e.target) && e.target.id !== 'btnFileMenu') closeAllMenus();
  if (contextMenuEl && !contextMenuEl.contains(e.target)) { contextMenuEl.remove(); contextMenuEl = null; }
  document.querySelectorAll('.export-menu').forEach(m => { if (!m.contains(e.target)) m.remove(); });
});

/* ============ TOOLTIPS / TOAST ============ */
const tooltipEl = document.getElementById('tooltip');
let tooltipTimer = null;
function showTooltipAt(el, text) {
  if (!text) return;
  const r = el.getBoundingClientRect();
  tooltipEl.textContent = text;
  tooltipEl.classList.remove('below');
  tooltipEl.style.left = (r.left + r.width / 2) + 'px';
  let top = r.top - 8;
  if (top < 40) { top = r.bottom + 8; tooltipEl.classList.add('below'); }
  tooltipEl.style.top = top + 'px';
  tooltipEl.classList.add('visible');
  clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(() => tooltipEl.classList.remove('visible'), 1500);
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[title]');
  if (!btn) return;
  const text = btn.getAttribute('title');
  if (!text) return;
  if (btn.textContent.trim().length > 4) return;
  showTooltipAt(btn, text);
});
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

/* ============ SIDEBAR ============ */
function isMobileLayout() { return window.matchMedia('(max-width: 720px)').matches; }
document.getElementById('btnToggleSidebar').addEventListener('click', () => document.body.classList.toggle('sidebar-collapsed'));
document.getElementById('btnCloseSidebar').addEventListener('click', () => document.body.classList.add('sidebar-collapsed'));
document.getElementById('sidebarBackdrop').addEventListener('click', () => document.body.classList.add('sidebar-collapsed'));
document.getElementById('panelAlpha').addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--panel-alpha', e.target.value);
});

/* ============ KEYBOARD ============ */
function onKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (state.pen.active) {
    if (e.key === 'Enter') { e.preventDefault(); finishPenPath(); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancelPenPath(); return; }
  }
  if (state.cropping && e.key === 'Escape') { e.preventDefault(); cancelCrop(); return; }
  if (state.pathEditing) {
    if (e.key === 'Escape') { e.preventDefault(); exitPathEdit(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedAnchor !== -1) {
      e.preventDefault(); deleteSelectedAnchor(); return;
    }
  }
  if (state.editingPowerClip && e.key === 'Escape') { e.preventDefault(); exitPowerClipEdit(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveJSON(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault(); if (e.shiftKey) redo(); else undo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    state.selection = new Set(state.doc.nodes.map(n => n.id));
    scheduleRender(); updatePropertiesPanel(); updateLayersPanel();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selection.size) { e.preventDefault(); deleteSelected(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const shortcuts = { v:'select', p:'pen', r:'rect', o:'ellipse', l:'line', t:'text', h:'hand' };
  const t = shortcuts[e.key.toLowerCase()];
  if (t) setTool(t);
}

scene.addEventListener('pointermove', (e) => {
  if (!state.pen.active || activePointerId !== null) return;
  const rect = getSceneRect();
  state.pen.mousePos = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  scheduleRender();
});

/* ============ INITIAL DOC + BOOT ============ */
function makeInitialDoc() {
  return {
    canvasW: 1200, canvasH: 800,
    guides: [],
    nodes: [
      { id: 'n1', type: 'rect', name: 'Gradient Box', x: 100, y: 100, w: 220, h: 160, rotation: 0,
        corners: { tl: 20, tr: 20, br: 20, bl: 20 },
        style: { fill: { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#ff6b6b' }, { offset: 1, color: '#4ecdc4' }] }, stroke: '#2a2a2a', strokeWidth: 2, opacity: 1 },
        effects: { shadow: { on: true, x: 6, y: 6, blur: 12, color: '#00000055' } } },
      { id: 'n2', type: 'ellipse', name: 'Radial Circle', x: 400, y: 100, w: 180, h: 180, rotation: 0,
        style: { fill: { type: 'radial', stops: [{ offset: 0, color: '#ffe66d' }, { offset: 1, color: '#ff8800' }] }, stroke: '#2a2a2a', strokeWidth: 2, opacity: 1 } },
      { id: 'n3', type: 'text', name: 'Greeting', x: 100, y: 350, w: 420, h: 70, rotation: 0,
        style: { fill: '#2a2a2a', stroke: '#2a2a2a', strokeWidth: 0, opacity: 1 }, text: 'Hello Vector!', fontSize: 56 },
      { id: 'n4', type: 'path', name: 'Triangle', x: 700, y: 400, w: 200, h: 180, rotation: 0,
        subpaths: [{ anchors: [
          { x: 800, y: 400, cIn: {x:0,y:0}, cOut: {x:0,y:0} },
          { x: 900, y: 580, cIn: {x:0,y:0}, cOut: {x:0,y:0} },
          { x: 700, y: 580, cIn: {x:0,y:0}, cOut: {x:0,y:0} },
        ], closed: true }],
        style: { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#c39bd3' }, { offset: 1, color: '#6c3483' }] }, stroke: '#2a2a2a', strokeWidth: 2, opacity: 1 } },
    ],
  };
}

function init() {
  state.doc = makeInitialDoc();
  if (isMobileLayout()) document.body.classList.add('sidebar-collapsed');

  render(); fitToView(); renderOverlay();
  drawRulers();
  updateLayersPanel(); updatePropertiesPanel(); updateCanvasSizeUI();
  updateHistoryButtons(); setTool('select');

  canvasArea.addEventListener('pointerdown', onCanvasPointerDown, true);
  canvasArea.addEventListener('pointermove', onCanvasPointerMove, true);
  canvasArea.addEventListener('pointerup', onCanvasPointerUp, true);
  canvasArea.addEventListener('pointercancel', onCanvasPointerUp, true);
  scene.addEventListener('pointerdown', onScenePointerDown);
  overlay.addEventListener('pointerdown', onOverlayPointerDown);
  scene.addEventListener('dblclick', onDblClick);
  canvasArea.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKeyDown);
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnRedo').addEventListener('click', redo);
  document.getElementById('btnFit').addEventListener('click', fitToView);
  bindRulers();
  new ResizeObserver(() => { scheduleRender(); drawRulers(); }).observe(canvasArea);
  window.addEventListener('resize', () => { scheduleRender(); drawRulers(); });
  window.matchMedia('(max-width: 720px)').addEventListener('change', (e) => {
    if (e.matches) document.body.classList.add('sidebar-collapsed');
    scheduleRender();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; autosaveDoc(); }
  });
  window.addEventListener('beforeunload', () => {
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; autosaveDoc(); }
  });

  (async () => {
    const saved = await loadAutosave();
    if (!saved || !saved.doc || !saved.doc.nodes || !saved.doc.nodes.length) { updateAutosaveIndicator('idle'); return; }
    if (JSON.stringify(saved.doc) === JSON.stringify(state.doc)) { updateAutosaveIndicator('saved'); return; }
    const ageMin = Math.round((Date.now() - saved.savedAt) / 60000);
    const ageLabel = ageMin < 1 ? 'just now' : (ageMin === 1 ? '1 minute ago' : `${ageMin} minutes ago`);
    const banner = document.getElementById('restoreBanner');
    document.getElementById('restoreBannerSub').textContent = 'from ' + ageLabel;
    banner.classList.add('show');
    document.getElementById('btnRestoreAutosave').onclick = () => {
      migrateDoc(saved.doc);
      state.doc = saved.doc;
      resetAfterHistory();
      path2dCache.clear(); imageCache.clear();
      state.history = { undo: [], redo: [] };
      updateHistoryButtons();
      render(); fitToView(); renderOverlay();
      updateLayersPanel(); updatePropertiesPanel(); updateCanvasSizeUI();
      banner.classList.remove('show');
      updateAutosaveIndicator('saved');
      showToast('✅ Restored from autosave');
    };
    document.getElementById('btnRestoreFresh').onclick = () => {
      banner.classList.remove('show');
      clearAutosave();
      updateAutosaveIndicator('idle');
    };
    setTimeout(() => { if (banner.classList.contains('show')) banner.classList.remove('show'); }, 30000);
  })();
}

init();
/* ============================================================
   SVG IMPORT
   ============================================================ */
function importSVG() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.svg,image/svg+xml';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const result = parseSVGText(reader.result);
        if (!result.nodes.length) { showToast('No drawable elements found'); return; }
        commitChange(() => {
          for (const n of result.nodes) state.doc.nodes.push(n);
          state.selection = new Set(result.nodes.map(n => n.id));
        });
        scheduleRender(); updateLayersPanel(); updatePropertiesPanel();
        showToast(`✅ Imported ${result.nodes.length} element${result.nodes.length > 1 ? 's' : ''}`);
      } catch (err) {
        console.error('SVG import error:', err);
        alert('Failed to import SVG: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function parseSVGText(text) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, 'image/svg+xml');
  if (xmlDoc.querySelector('parsererror')) throw new Error('Invalid SVG file');
  const svg = xmlDoc.querySelector('svg');
  if (!svg) throw new Error('No <svg> element found');

  const viewBox = svg.getAttribute('viewBox');
  let vbX = 0, vbY = 0, vbW = 0, vbH = 0;
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(parseFloat);
    [vbX, vbY, vbW, vbH] = parts;
  }
  const svgW = parseFloat(svg.getAttribute('width')) || vbW || 800;
  const svgH = parseFloat(svg.getAttribute('height')) || vbH || 600;
  const srcW = vbW || svgW;
  const srcH = vbH || svgH;

  // Fit SVG ke ~80% canvas, ter-center
  const cW = state.doc.canvasW, cH = state.doc.canvasH;
  const fitScale = Math.min(cW / srcW, cH / srcH) * 0.8;
  const offsetX = (cW - srcW * fitScale) / 2 - vbX * fitScale;
  const offsetY = (cH - srcH * fitScale) / 2 - vbY * fitScale;
  const rootMatrix = [fitScale, 0, 0, fitScale, offsetX, offsetY];

  const nodes = [];
  for (const child of svg.children) {
    const result = parseSVGElement(child, rootMatrix);
    if (result) {
      if (Array.isArray(result)) nodes.push(...result);
      else nodes.push(result);
    }
  }
  return { nodes, width: srcW, height: srcH };
}

function parseSVGElement(el, parentMatrix) {
  const tag = el.tagName.toLowerCase();
  const skipTags = ['defs','title','desc','metadata','style','script','clippath','mask','filter','lineargradient','radialgradient','pattern','symbol','marker','use','foreignobject'];
  if (skipTags.includes(tag)) return null;

  const localMatrix = parseSVGTransform(el.getAttribute('transform'));
  const matrix = multiplyMatrix(parentMatrix, localMatrix);
  const style = extractSVGStyle(el);

  if (tag === 'g') {
    const children = [];
    for (const child of el.children) {
      const result = parseSVGElement(child, matrix);
      if (result) {
        if (Array.isArray(result)) children.push(...result);
        else children.push(result);
      }
    }
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { id: genId(), type: 'group', name: el.getAttribute('id') || 'Group', children };
  }

  let node = null;

  if (tag === 'rect') {
    const x = parseFloat(el.getAttribute('x')) || 0;
    const y = parseFloat(el.getAttribute('y')) || 0;
    const w = parseFloat(el.getAttribute('width')) || 0;
    const h = parseFloat(el.getAttribute('height')) || 0;
    if (w <= 0 || h <= 0) return null;
    const rx = parseFloat(el.getAttribute('rx')) || 0;
    const ry = parseFloat(el.getAttribute('ry')) || rx;
    const r = Math.min(Math.max(rx, ry), w/2, h/2);
    let anchors;
    if (r > 0) {
      const k = 0.5522847498 * r;
      anchors = [
        makeAnchor(x + r, y, { cInX: -k, cInY: 0, cOutX: 0, cOutY: 0 }),
        makeAnchor(x + w - r, y, { cInX: 0, cInY: 0, cOutX: k, cOutY: 0 }),
        makeAnchor(x + w, y + r, { cInX: 0, cInY: -k, cOutX: 0, cOutY: 0 }),
        makeAnchor(x + w, y + h - r, { cInX: 0, cInY: 0, cOutX: 0, cOutY: k }),
        makeAnchor(x + w - r, y + h, { cInX: k, cInY: 0, cOutX: 0, cOutY: 0 }),
        makeAnchor(x + r, y + h, { cInX: 0, cInY: 0, cOutX: -k, cOutY: 0 }),
        makeAnchor(x, y + h - r, { cInX: 0, cInY: k, cOutX: 0, cOutY: 0 }),
        makeAnchor(x, y + r, { cInX: 0, cInY: 0, cOutX: 0, cOutY: -k }),
      ];
    } else {
      anchors = [makeAnchor(x,y), makeAnchor(x+w,y), makeAnchor(x+w,y+h), makeAnchor(x,y+h)];
    }
    const subpaths = [{ anchors, closed: true }];
    transformSubpaths(subpaths, matrix);
    node = { id: genId(), type: 'path', name: el.getAttribute('id') || 'Rect', subpaths, rotation: 0, style: svgStyleToNodeStyle(style) };
    computePathBoundsInto(node);
  } else if (tag === 'circle') {
    const cx = parseFloat(el.getAttribute('cx')) || 0;
    const cy = parseFloat(el.getAttribute('cy')) || 0;
    const r = parseFloat(el.getAttribute('r')) || 0;
    if (r <= 0) return null;
    const k = 0.5522847498 * r;
    const anchors = [
      makeAnchor(cx, cy-r, { cInX: -k, cInY: 0, cOutX: k, cOutY: 0 }),
      makeAnchor(cx+r, cy, { cInX: 0, cInY: -k, cOutX: 0, cOutY: k }),
      makeAnchor(cx, cy+r, { cInX: k, cInY: 0, cOutX: -k, cOutY: 0 }),
      makeAnchor(cx-r, cy, { cInX: 0, cInY: k, cOutX: 0, cOutY: -k }),
    ];
    const subpaths = [{ anchors, closed: true }];
    transformSubpaths(subpaths, matrix);
    node = { id: genId(), type: 'path', name: el.getAttribute('id') || 'Circle', subpaths, rotation: 0, style: svgStyleToNodeStyle(style) };
    computePathBoundsInto(node);
  } else if (tag === 'ellipse') {
    const cx = parseFloat(el.getAttribute('cx')) || 0;
    const cy = parseFloat(el.getAttribute('cy')) || 0;
    const rx = parseFloat(el.getAttribute('rx')) || 0;
    const ry = parseFloat(el.getAttribute('ry')) || 0;
    if (rx <= 0 || ry <= 0) return null;
    const kx = 0.5522847498 * rx, ky = 0.5522847498 * ry;
    const anchors = [
      makeAnchor(cx, cy-ry, { cInX: -kx, cInY: 0, cOutX: kx, cOutY: 0 }),
      makeAnchor(cx+rx, cy, { cInX: 0, cInY: -ky, cOutX: 0, cOutY: ky }),
      makeAnchor(cx, cy+ry, { cInX: kx, cInY: 0, cOutX: -kx, cOutY: 0 }),
      makeAnchor(cx-rx, cy, { cInX: 0, cInY: ky, cOutX: 0, cOutY: -ky }),
    ];
    const subpaths = [{ anchors, closed: true }];
    transformSubpaths(subpaths, matrix);
    node = { id: genId(), type: 'path', name: el.getAttribute('id') || 'Ellipse', subpaths, rotation: 0, style: svgStyleToNodeStyle(style) };
    computePathBoundsInto(node);
  } else if (tag === 'line') {
    const x1 = parseFloat(el.getAttribute('x1')) || 0;
    const y1 = parseFloat(el.getAttribute('y1')) || 0;
    const x2 = parseFloat(el.getAttribute('x2')) || 0;
    const y2 = parseFloat(el.getAttribute('y2')) || 0;
    const anchors = [makeAnchor(x1,y1), makeAnchor(x2,y2)];
    const subpaths = [{ anchors, closed: false }];
    transformSubpaths(subpaths, matrix);
    node = { id: genId(), type: 'path', name: el.getAttribute('id') || 'Line', subpaths, rotation: 0, style: svgStyleToNodeStyle(style, true) };
    computePathBoundsInto(node);
  } else if (tag === 'polyline' || tag === 'polygon') {
    const pts = (el.getAttribute('points') || '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)?.map(parseFloat) || [];
    if (pts.length < 4) return null;
    const anchors = [];
    for (let i = 0; i < pts.length; i += 2) anchors.push(makeAnchor(pts[i], pts[i+1]));
    const subpaths = [{ anchors, closed: tag === 'polygon' }];
    transformSubpaths(subpaths, matrix);
    node = { id: genId(), type: 'path', name: el.getAttribute('id') || tag, subpaths, rotation: 0, style: svgStyleToNodeStyle(style, tag === 'polyline') };
    computePathBoundsInto(node);
  } else if (tag === 'path') {
    const d = el.getAttribute('d') || '';
    if (!d.trim()) return null;
    const subpaths = parseSVGPathData(d);
    if (!subpaths.length) return null;
    transformSubpaths(subpaths, matrix);
    const hasClosed = subpaths.some(sp => sp.closed);
    node = { id: genId(), type: 'path', name: el.getAttribute('id') || 'Path', subpaths, rotation: 0, style: svgStyleToNodeStyle(style, !hasClosed) };
    const fillRule = el.getAttribute('fill-rule') || style['fill-rule'];
    if (fillRule) node.fillRule = fillRule;
    computePathBoundsInto(node);
  } else if (tag === 'text') {
    const x = parseFloat(el.getAttribute('x')) || 0;
    const y = parseFloat(el.getAttribute('y')) || 0;
    const content = el.textContent || '';
    if (!content.trim()) return null;
    const fontSize = parseFloat(el.getAttribute('font-size')) || parseFloat((style['font-size'] || '').replace('px','')) || 32;
    const pos = applyMatrixToPoint(matrix, x, y);
    const textW = Math.max(50, content.length * fontSize * 0.55);
    const textH = fontSize * 1.2;
    node = {
      id: genId(), type: 'text', name: el.getAttribute('id') || 'Text',
      x: pos.x, y: pos.y - fontSize, w: textW, h: textH, rotation: 0,
      text: content, fontSize, style: svgStyleToNodeStyle(style),
    };
  } else if (tag === 'image') {
    const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || el.getAttribute('xlink:href');
    if (!href || !href.startsWith('data:')) return null;
    const x = parseFloat(el.getAttribute('x')) || 0;
    const y = parseFloat(el.getAttribute('y')) || 0;
    const w = parseFloat(el.getAttribute('width')) || 0;
    const h = parseFloat(el.getAttribute('height')) || 0;
    if (w <= 0 || h <= 0) return null;
    const p1 = applyMatrixToPoint(matrix, x, y);
    const p2 = applyMatrixToPoint(matrix, x + w, y + h);
    node = {
      id: genId(), type: 'image', name: el.getAttribute('id') || 'Image',
      x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y,
      rotation: 0, src: href, style: svgStyleToNodeStyle(style),
    };
  }
  return node;
}

function extractSVGStyle(el) {
  const style = {};
  for (const attr of ['fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','fill-rule','font-size']) {
    const val = el.getAttribute(attr);
    if (val !== null) style[attr] = val;
  }
  const inline = el.getAttribute('style');
  if (inline) {
    for (const part of inline.split(';')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k && v) style[k] = v;
    }
  }
  return style;
}

function svgStyleToNodeStyle(style, noFill) {
  let fill = style.fill !== undefined ? style.fill : '#000000';
  let stroke = style.stroke !== undefined ? style.stroke : 'none';
  const strokeWidth = parseFloat(style['stroke-width']) || 1;
  let opacity = parseFloat(style.opacity);
  if (isNaN(opacity)) opacity = 1;
  if (fill && fill.startsWith('url(')) fill = '#888888';
  if (stroke && stroke.startsWith('url(')) stroke = '#333333';
  if (noFill && fill !== 'none') fill = 'none';
  return {
    fill: fill === 'none' ? 'none' : svgColorToHex(fill),
    stroke: stroke === 'none' ? 'none' : svgColorToHex(stroke),
    strokeWidth,
    opacity: Math.max(0, Math.min(1, opacity)),
  };
}

function svgColorToHex(c) {
  if (!c) return '#000000';
  c = String(c).trim().toLowerCase();
  if (c === 'none' || c === 'transparent') return 'none';
  if (c.startsWith('#')) return c;
  if (c.startsWith('rgb')) {
    const nums = c.match(/\d+(?:\.\d+)?/g)?.map(Number) || [0,0,0];
    const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + toHex(nums[0]||0) + toHex(nums[1]||0) + toHex(nums[2]||0);
  }
  const named = { black:'#000000', white:'#ffffff', red:'#ff0000', green:'#008000', blue:'#0000ff',
    yellow:'#ffff00', cyan:'#00ffff', magenta:'#ff00ff', gray:'#808080', grey:'#808080',
    orange:'#ffa500', purple:'#800080', pink:'#ffc0cb', brown:'#a52a2a', navy:'#000080',
    teal:'#008080', olive:'#808000', lime:'#00ff00', maroon:'#800000', silver:'#c0c0c0',
    aqua:'#00ffff', fuchsia:'#ff00ff' };
  return named[c] || '#000000';
}

function computePathBoundsInto(node) {
  const b = computePathBounds(node);
  node.x = b.x; node.y = b.y; node.w = b.w; node.h = b.h;
}

function transformSubpaths(subpaths, matrix) {
  const [a, b, c, d, e, f] = matrix;
  for (const sp of subpaths) {
    for (const anchor of sp.anchors) {
      const nx = a * anchor.x + c * anchor.y + e;
      const ny = b * anchor.x + d * anchor.y + f;
      anchor.x = nx; anchor.y = ny;
      const nix = a * anchor.cIn.x + c * anchor.cIn.y;
      const niy = b * anchor.cIn.x + d * anchor.cIn.y;
      anchor.cIn.x = nix; anchor.cIn.y = niy;
      const nox = a * anchor.cOut.x + c * anchor.cOut.y;
      const noy = b * anchor.cOut.x + d * anchor.cOut.y;
      anchor.cOut.x = nox; anchor.cOut.y = noy;
    }
  }
}

function parseSVGPathData(d) {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  let i = 0;
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let lastCx = null, lastCy = null, lastCmd = '';
  const subpaths = [];
  let current = null;

  function ensureSubpath() {
    if (!current) { current = { anchors: [], closed: false }; subpaths.push(current); }
  }
  function addAnchor(x, y, cIn, cOut) {
    ensureSubpath();
    current.anchors.push({ x, y, cIn: cIn || {x:0,y:0}, cOut: cOut || {x:0,y:0} });
  }
  function num() { return parseFloat(tokens[i++]); }

  while (i < tokens.length) {
    let cmd = tokens[i];
    let isRel = false;
    if (/^[a-zA-Z]$/.test(cmd)) {
      isRel = cmd === cmd.toLowerCase();
      i++;
    } else if (lastCmd) {
      cmd = lastCmd;
      isRel = cmd === cmd.toLowerCase();
    } else { i++; continue; }

    const C = cmd.toUpperCase();
    if (C === 'M') {
      const x = num(), y = num();
      cx = isRel ? cx + x : x;
      cy = isRel ? cy + y : y;
      startX = cx; startY = cy;
      current = { anchors: [], closed: false };
      subpaths.push(current);
      addAnchor(cx, cy);
      lastCx = null; lastCy = null;
    } else if (C === 'L') {
      const x = num(), y = num();
      cx = isRel ? cx + x : x;
      cy = isRel ? cy + y : y;
      addAnchor(cx, cy);
      lastCx = null; lastCy = null;
    } else if (C === 'H') {
      const x = num();
      cx = isRel ? cx + x : x;
      addAnchor(cx, cy);
      lastCx = null; lastCy = null;
    } else if (C === 'V') {
      const y = num();
      cy = isRel ? cy + y : y;
      addAnchor(cx, cy);
      lastCx = null; lastCy = null;
    } else if (C === 'C') {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      const c1x = isRel ? cx + x1 : x1, c1y = isRel ? cy + y1 : y1;
      const c2x = isRel ? cx + x2 : x2, c2y = isRel ? cy + y2 : y2;
      const nx = isRel ? cx + x : x, ny = isRel ? cy + y : y;
      const last = current.anchors[current.anchors.length - 1];
      if (last) last.cOut = { x: c1x - last.x, y: c1y - last.y };
      addAnchor(nx, ny, { x: c2x - nx, y: c2y - ny });
      lastCx = c2x; lastCy = c2y; cx = nx; cy = ny;
    } else if (C === 'S') {
      const x2 = num(), y2 = num(), x = num(), y = num();
      const c1x = lastCx !== null ? 2*cx - lastCx : cx;
      const c1y = lastCy !== null ? 2*cy - lastCy : cy;
      const c2x = isRel ? cx + x2 : x2, c2y = isRel ? cy + y2 : y2;
      const nx = isRel ? cx + x : x, ny = isRel ? cy + y : y;
      const last = current.anchors[current.anchors.length - 1];
      if (last) last.cOut = { x: c1x - last.x, y: c1y - last.y };
      addAnchor(nx, ny, { x: c2x - nx, y: c2y - ny });
      lastCx = c2x; lastCy = c2y; cx = nx; cy = ny;
    } else if (C === 'Q') {
      const qx = num(), qy = num(), x = num(), y = num();
      const qcx = isRel ? cx + qx : qx, qcy = isRel ? cy + qy : qy;
      const nx = isRel ? cx + x : x, ny = isRel ? cy + y : y;
      const c1x = cx + (2/3)*(qcx - cx), c1y = cy + (2/3)*(qcy - cy);
      const c2x = nx + (2/3)*(qcx - nx), c2y = ny + (2/3)*(qcy - ny);
      const last = current.anchors[current.anchors.length - 1];
      if (last) last.cOut = { x: c1x - last.x, y: c1y - last.y };
      addAnchor(nx, ny, { x: c2x - nx, y: c2y - ny });
      lastCx = qcx; lastCy = qcy; cx = nx; cy = ny;
    } else if (C === 'T') {
      const x = num(), y = num();
      const qcx = lastCx !== null ? 2*cx - lastCx : cx;
      const qcy = lastCy !== null ? 2*cy - lastCy : cy;
      const nx = isRel ? cx + x : x, ny = isRel ? cy + y : y;
      const c1x = cx + (2/3)*(qcx - cx), c1y = cy + (2/3)*(qcy - cy);
      const c2x = nx + (2/3)*(qcx - nx), c2y = ny + (2/3)*(qcy - ny);
      const last = current.anchors[current.anchors.length - 1];
      if (last) last.cOut = { x: c1x - last.x, y: c1y - last.y };
      addAnchor(nx, ny, { x: c2x - nx, y: c2y - ny });
      lastCx = qcx; lastCy = qcy; cx = nx; cy = ny;
    } else if (C === 'A') {
      const rx = num(), ry = num(), xrot = num(), large = num(), sweep = num(), x = num(), y = num();
      const nx = isRel ? cx + x : x, ny = isRel ? cy + y : y;
      const beziers = arcToBezier(cx, cy, rx, ry, xrot, large, sweep, nx, ny);
      const lastAnchor = current.anchors[current.anchors.length - 1];
      if (lastAnchor && beziers.length > 0) {
        lastAnchor.cOut = { x: beziers[0].c1.x - lastAnchor.x, y: beziers[0].c1.y - lastAnchor.y };
      }
      for (let bi = 0; bi < beziers.length; bi++) {
        const seg = beziers[bi];
        const isLast = bi === beziers.length - 1;
        const newA = { x: seg.p2.x, y: seg.p2.y, cIn: { x: seg.c2.x - seg.p2.x, y: seg.c2.y - seg.p2.y }, cOut: { x: 0, y: 0 } };
        if (!isLast) {
          const nextSeg = beziers[bi + 1];
          newA.cOut = { x: nextSeg.c1.x - seg.p2.x, y: nextSeg.c1.y - seg.p2.y };
        }
        current.anchors.push(newA);
      }
      cx = nx; cy = ny;
      lastCx = null; lastCy = null;
    } else if (C === 'Z') {
      if (current) {
        current.closed = true;
        if (current.anchors.length > 1) {
          const first = current.anchors[0];
          const last = current.anchors[current.anchors.length - 1];
          if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) {
            first.cIn = last.cIn;
            current.anchors.pop();
          }
        }
        cx = startX; cy = startY;
        current = null;
      }
      lastCx = null; lastCy = null;
    } else { i++; continue; }

    lastCmd = (C === 'M') ? (isRel ? 'l' : 'L') : cmd;
  }
  return subpaths.filter(sp => sp.anchors.length > 0);
}

function arcToBezier(x1, y1, rx, ry, phi, largeArc, sweep, x2, y2) {
  if (rx === 0 || ry === 0) return [{ p0:{x:x1,y:y1}, c1:{x:x1,y:y1}, c2:{x:x2,y:y2}, p2:{x:x2,y:y2} }];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phiRad = phi * Math.PI / 180;
  const cosPhi = Math.cos(phiRad), sinPhi = Math.sin(phiRad);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosPhi*dx + sinPhi*dy;
  const y1p = -sinPhi*dx + cosPhi*dy;
  const lambda = (x1p*x1p)/(rx*rx) + (y1p*y1p)/(ry*ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const rx2 = rx*rx, ry2 = ry*ry;
  const x1p2 = x1p*x1p, y1p2 = y1p*y1p;
  const sign = (largeArc !== sweep) ? 1 : -1;
  const n = Math.max(0, rx2*ry2 - rx2*y1p2 - ry2*x1p2);
  const d = rx2*y1p2 + ry2*x1p2;
  if (d === 0) return [];
  const coef = sign * Math.sqrt(n / d);
  const cxp = coef * (rx * y1p / ry);
  const cyp = coef * -(ry * x1p / rx);
  const cx = cosPhi*cxp - sinPhi*cyp + (x1 + x2)/2;
  const cy = sinPhi*cxp + cosPhi*cyp + (y1 + y2)/2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux*vx + uy*vy;
    const len = Math.sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy));
    let a = Math.acos(Math.max(-1, Math.min(1, dot/len)));
    if (ux*vy - uy*vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry);
  let dTheta = ang((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry);
  if (!sweep && dTheta > 0) dTheta -= 2*Math.PI;
  if (sweep && dTheta < 0) dTheta += 2*Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI/2)));
  const delta = dTheta / segments;
  const t = (4/3) * Math.tan(delta / 4);
  const result = [];
  let theta = theta1, px = x1, py = y1;
  for (let s = 0; s < segments; s++) {
    const theta2 = theta + delta;
    const c1 = Math.cos(theta), s1 = Math.sin(theta);
    const c2 = Math.cos(theta2), s2 = Math.sin(theta2);
    const xT2 = rx*c2, yT2 = ry*s2;
    const ex = cosPhi*xT2 - sinPhi*yT2 + cx;
    const ey = sinPhi*xT2 + cosPhi*yT2 + cy;
    const c1xT = rx*(c1 - t*s1), c1yT = ry*(s1 + t*c1);
    const c2xT = rx*(c2 + t*s2), c2yT = ry*(s2 - t*c2);
    const c1x = cosPhi*c1xT - sinPhi*c1yT + cx;
    const c1y = sinPhi*c1xT + cosPhi*c1yT + cy;
    const c2x = cosPhi*c2xT - sinPhi*c2yT + cx;
    const c2y = sinPhi*c2xT + cosPhi*c2yT + cy;
    result.push({ p0:{x:px,y:py}, c1:{x:c1x,y:c1y}, c2:{x:c2x,y:c2y}, p2:{x:ex,y:ey} });
    px = ex; py = ey;
    theta = theta2;
  }
  return result;
}

function parseSVGTransform(str) {
  let m = [1, 0, 0, 1, 0, 0];
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let match;
  while ((match = re.exec(str)) !== null) {
    const fn = match[1].toLowerCase();
    const args = match[2].split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    let local = [1, 0, 0, 1, 0, 0];
    if (fn === 'matrix' && args.length >= 6) {
      local = [args[0], args[1], args[2], args[3], args[4], args[5]];
    } else if (fn === 'translate' && args.length >= 1) {
      local = [1, 0, 0, 1, args[0], args[1] || 0];
    } else if (fn === 'scale' && args.length >= 1) {
      const sx = args[0], sy = args.length >= 2 ? args[1] : sx;
      local = [sx, 0, 0, sy, 0, 0];
    } else if (fn === 'rotate' && args.length >= 1) {
      const a = args[0] * Math.PI / 180;
      const cs = Math.cos(a), sn = Math.sin(a);
      local = [cs, sn, -sn, cs, 0, 0];
      if (args.length >= 3) {
        const t1 = [1, 0, 0, 1, args[1], args[2]];
        const t2 = [1, 0, 0, 1, -args[1], -args[2]];
        local = multiplyMatrix(multiplyMatrix(t1, local), t2);
      }
    } else if (fn === 'skewx' && args.length >= 1) {
      local = [1, 0, Math.tan(args[0] * Math.PI / 180), 1, 0, 0];
    } else if (fn === 'skewy' && args.length >= 1) {
      local = [1, Math.tan(args[0] * Math.PI / 180), 0, 1, 0, 0];
    }
    m = multiplyMatrix(m, local);
  }
  return m;
}

function multiplyMatrix(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1*a2 + c1*b2,
    b1*a2 + d1*b2,
    a1*c2 + c1*d2,
    b1*c2 + d1*d2,
    a1*e2 + c1*f2 + e1,
    b1*e2 + d1*f2 + f1,
  ];
}

function applyMatrixToPoint(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}