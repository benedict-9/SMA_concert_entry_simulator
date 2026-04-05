// ═══════════════════════════════════════════════════════════
//  Concert Entry Simulator  –  Discrete-Event Simulation
//  Flow: Arrive → Holding Queue → [Batch Release] →
//        [Bag Check (VIP lane / Normal lanes)] →
//        [Wristband] → [Water] → Enter Venue
// ═══════════════════════════════════════════════════════════

// ── CONFIG (live-editable via sidebar) ──────────────────────
let CFG = {
  totalAttendees:  500,
  vipPct:          0.10,   // fraction
  arrivalWindow:   60,     // minutes
  bagPct:          0.70,
  batchSize:       30,
  batchInterval:   20,     // sim-seconds between releases
  bagLanes:        3,      // normal lanes (VIP lane is always +1)
  vipSpillover:    true,   // VIP lane serves normal when idle
  wristCounters:   2,
  waterStations:   2,
  wristPct:        0.60,
  waterPct:        0.40,
  simSpeed:        5,      // multiplier
};

// ── SERVICE TIME DISTRIBUTIONS (sim-seconds) ────────────────
const SVC = {
  bagVIP:      () => jStat.lognormal.sample(Math.log(15), 0.3),   // ~15s
  bagNormal:   () => jStat.lognormal.sample(Math.log(25), 0.5),   // ~25s, high variance
  wristband:   () => jStat.lognormal.sample(Math.log(10), 0.3),
  water:       () => jStat.lognormal.sample(Math.log(8),  0.3),
};

// ── ATTENDEE STATES ─────────────────────────────────────────
const S = {
  ARRIVING:   'arriving',
  HOLDING:    'holding',
  BAG_QUEUE:  'bag_queue',
  BAG_SVC:    'bag_svc',
  WRIST_QUEUE:'wrist_queue',
  WRIST_SVC:  'wrist_svc',
  WATER_QUEUE:'water_queue',
  WATER_SVC:  'water_svc',
  ENTERED:    'entered',
};

// ── SIMULATION STATE ─────────────────────────────────────────
let simTime   = 0;   // seconds
let isRunning = false;
let animFrame = null;
let lastWall  = null;

let attendees = [];
let nextID    = 0;

// queues
let holdingQueue  = [];
let bagQueueVIP   = [];
let bagQueueNorm  = [];
let wristQueue    = [];
let waterQueue    = [];

// servers: array of { busyUntil, servedCount }
let bagServers  = [];   // index 0 = VIP lane, 1..N = normal lanes
let wristServers= [];
let waterServers= [];

// batch release timer
let nextBatchAt = 0;

// stats
let waitTimes = [];   // total wait (arrival → entered) for completed attendees

// ── HELPERS ─────────────────────────────────────────────────
function rand()          { return Math.random(); }
function randBool(p)     { return rand() < p; }
function randArrival(w)  { return rand() * w * 60; } // uniform over window (seconds)

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const i = Math.ceil(p * s.length) - 1;
  return s[Math.max(0,i)];
}

// ── INITIALISE ATTENDEES ─────────────────────────────────────
function spawnAttendees() {
  attendees = [];
  nextID    = 0;
  const n   = CFG.totalAttendees;
  for (let i = 0; i < n; i++) {
    attendees.push({
      id:          nextID++,
      isVIP:       randBool(CFG.vipPct),
      hasBag:      randBool(CFG.bagPct),
      needsWrist:  randBool(CFG.wristPct),
      wantsWater:  randBool(CFG.waterPct),
      arrivalTime: randArrival(CFG.arrivalWindow),
      state:       S.ARRIVING,
      enteredAt:   null,
      queuedAt:    null,   // time they first joined any queue
    });
  }
  attendees.sort((a,b) => a.arrivalTime - b.arrivalTime);
}

// ── RESET ────────────────────────────────────────────────────
function reset() {
  isRunning = false;
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  simTime       = 0;
  lastWall      = null;
  holdingQueue  = [];
  bagQueueVIP   = [];
  bagQueueNorm  = [];
  wristQueue    = [];
  waterQueue    = [];
  waitTimes     = [];
  nextBatchAt   = 0;

  bagServers   = Array.from({length: CFG.bagLanes + 1}, () => ({ busyUntil: 0, servedCount: 0 }));
  wristServers = Array.from({length: CFG.wristCounters},  () => ({ busyUntil: 0, servedCount: 0 }));
  waterServers = Array.from({length: CFG.waterStations},  () => ({ busyUntil: 0, servedCount: 0 }));

  spawnAttendees();
  updateStats();
  drawScene();
}

// ── SIMULATION STEP ──────────────────────────────────────────
// Advances simTime by `dt` seconds and processes all events.
function simStep(dt) {
  simTime += dt;

  // 1. Move arriving attendees into holding queue
  for (const a of attendees) {
    if (a.state === S.ARRIVING && a.arrivalTime <= simTime) {
      a.state    = S.HOLDING;
      a.queuedAt = simTime;
      holdingQueue.push(a);
    }
  }

  // 2. Batch release from holding queue
  if (simTime >= nextBatchAt && holdingQueue.length > 0) {
    const n = Math.min(CFG.batchSize, holdingQueue.length);
    const released = holdingQueue.splice(0, n);
    for (const a of released) {
      if (a.hasBag) {
        a.state = S.BAG_QUEUE;
        if (a.isVIP) bagQueueVIP.push(a);
        else         bagQueueNorm.push(a);
      } else {
        routeAfterBag(a);
      }
    }
    nextBatchAt = simTime + CFG.batchInterval;
  }

  // 3. Bag check servers
  //    Server 0 = VIP lane: serves VIP first, then normal if spillover enabled
  //    Servers 1..N = normal lanes: normal only
  processServer(bagServers, 0, bagQueueVIP, bagQueueNorm, S.BAG_SVC, SVC.bagVIP, SVC.bagNormal, true,  routeAfterBag);
  for (let i = 1; i < bagServers.length; i++) {
    processServer(bagServers, i, bagQueueNorm, null, S.BAG_SVC, SVC.bagNormal, null, false, routeAfterBag);
  }

  // 4. Wristband servers
  for (let i = 0; i < wristServers.length; i++) {
    processServer(wristServers, i, wristQueue, null, S.WRIST_SVC, SVC.wristband, null, false, routeAfterWrist);
  }

  // 5. Water servers
  for (let i = 0; i < waterServers.length; i++) {
    processServer(waterServers, i, waterQueue, null, S.WATER_SVC, SVC.water, null, false, routeAfterWater);
  }
}

/**
 * Generic server processor.
 * @param {Array}    servers      - array of server objects
 * @param {number}   idx          - which server
 * @param {Array}    primaryQ     - primary queue to pull from
 * @param {Array}    secondaryQ   - fallback queue (nullable)
 * @param {string}   svcState     - state while being served
 * @param {Function} svcTimePri   - service time fn for primary
 * @param {Function} svcTimeSec   - service time fn for secondary (nullable)
 * @param {boolean}  isVIPLane    - whether this is the VIP lane
 * @param {Function} onDone       - callback when service completes
 */
function processServer(servers, idx, primaryQ, secondaryQ, svcState, svcTimePri, svcTimeSec, isVIPLane, onDone) {
  const srv = servers[idx];

  // complete service for attendee currently being served
  if (srv.current && simTime >= srv.busyUntil) {
    const done = srv.current;
    srv.current = null;
    srv.servedCount++;
    onDone(done);
  }

  // pick up next attendee if idle
  if (!srv.current) {
    let next = null;
    let svcFn = svcTimePri;

    if (primaryQ.length > 0) {
      next  = primaryQ.shift();
    } else if (secondaryQ && secondaryQ.length > 0 && (isVIPLane ? CFG.vipSpillover : true)) {
      next  = secondaryQ.shift();
      svcFn = svcTimeSec || svcTimePri;
    }

    if (next) {
      next.state    = svcState;
      srv.current   = next;
      srv.busyUntil = simTime + svcFn();
    }
  }
}

// ── ROUTING AFTER EACH STAGE ─────────────────────────────────
function routeAfterBag(a) {
  if (a.needsWrist) {
    a.state = S.WRIST_QUEUE;
    wristQueue.push(a);
  } else {
    routeAfterWrist(a);
  }
}

function routeAfterWrist(a) {
  if (a.wantsWater) {
    a.state = S.WATER_QUEUE;
    waterQueue.push(a);
  } else {
    routeAfterWater(a);
  }
}

function routeAfterWater(a) {
  a.state     = S.ENTERED;
  a.enteredAt = simTime;
  if (a.queuedAt !== null) {
    waitTimes.push((a.enteredAt - a.queuedAt) / 60); // convert to minutes
  }
}

// ── STATS ────────────────────────────────────────────────────
function updateStats() {
  const entered = attendees.filter(a => a.state === S.ENTERED).length;
  document.getElementById('stat-holding').textContent  = holdingQueue.length;
  document.getElementById('stat-bagq').textContent     = bagQueueVIP.length + bagQueueNorm.length;
  document.getElementById('stat-wristq').textContent   = wristQueue.length;
  document.getElementById('stat-waterq').textContent   = waterQueue.length;
  document.getElementById('stat-entered').textContent  = entered;

  if (waitTimes.length > 0) {
    const avg = waitTimes.reduce((s,v)=>s+v,0) / waitTimes.length;
    document.getElementById('stat-avgwait').textContent = avg.toFixed(1);
    document.getElementById('stat-p95wait').textContent = percentile(waitTimes, 0.95).toFixed(1);
  } else {
    document.getElementById('stat-avgwait').textContent = '—';
    document.getElementById('stat-p95wait').textContent = '—';
  }

  document.getElementById('clock').textContent = `T = ${(simTime/60).toFixed(1)} min`;
}

// ═══════════════════════════════════════════════════════════
//  D3 VISUALISATION
// ═══════════════════════════════════════════════════════════

let svg, W, H;

// Layout constants (will be computed on init)
let LY = {};

function initCanvas() {
  d3.select('#canvas').selectAll('*').remove();
  const el = document.getElementById('canvas');
  W = el.clientWidth;
  H = el.clientHeight;

  svg = d3.select('#canvas').append('svg')
    .attr('width', W)
    .attr('height', H);

  // arrowhead marker
  svg.append('defs').append('marker')
    .attr('id', 'arrowhead')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 8).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', '#555');

  computeLayout();
  drawStaticScene();
}

function computeLayout() {
  const pad   = 24;
  const cols  = 5;  // Holding | BagCheck | Wristband | Water | Venue
  const colW  = (W - pad * 2) / cols;

  LY = {
    pad, colW,
    xHolding:   pad + colW * 0.5,
    xBag:       pad + colW * 1.5,
    xWrist:     pad + colW * 2.5,
    xWater:     pad + colW * 3.5,
    xVenue:     pad + colW * 4.5,

    stageY:     H * 0.07,   // label row
    laneTop:    H * 0.14,   // top of lane boxes
    laneH:      H * 0.72,   // boxes take most of the height
    qBarY:      H * 0.89,   // queue count label row
    boxW:       colW * 0.84,
  };
}

function drawStaticScene() {
  const g = svg.append('g').attr('class', 'static-layer');

  // ── arrows between stages ──
  const stages = [LY.xHolding, LY.xBag, LY.xWrist, LY.xWater, LY.xVenue];
  const arrowY = LY.laneTop + LY.laneH / 2;
  for (let i = 0; i < stages.length - 1; i++) {
    g.append('line')
      .attr('class', 'arrow')
      .attr('x1', stages[i] + LY.boxW / 2 + 4)
      .attr('y1', arrowY)
      .attr('x2', stages[i+1] - LY.boxW / 2 - 4)
      .attr('y2', arrowY);
  }

  // ── stage labels ──
  const labels = ['Holding\nQueue', 'Bag Check', 'Wristband', 'Water\nRefill', 'Venue'];
  stages.forEach((x, i) => {
    const lines = labels[i].split('\n');
    const t = g.append('text').attr('class', 'stage-label').attr('x', x).attr('y', LY.stageY);
    lines.forEach((l, li) => t.append('tspan').attr('x', x).attr('dy', li === 0 ? 0 : '1.2em').text(l));
  });

  // ── holding box ──
  g.append('rect')
    .attr('class', 'holding-box')
    .attr('x', LY.xHolding - LY.boxW/2)
    .attr('y', LY.laneTop)
    .attr('width', LY.boxW)
    .attr('height', LY.laneH)
    .attr('rx', 6);

  // ── venue box ──
  g.append('rect')
    .attr('class', 'venue-box')
    .attr('x', LY.xVenue - LY.boxW/2)
    .attr('y', LY.laneTop)
    .attr('width', LY.boxW)
    .attr('height', LY.laneH)
    .attr('rx', 6);

  g.append('text').attr('class', 'lane-label')
    .attr('x', LY.xVenue).attr('y', LY.laneTop + LY.laneH/2)
    .text('🎵');
}

// ── DYNAMIC DRAW ─────────────────────────────────────────────
function drawScene() {
  drawLanes();
  drawQueueBars();
  drawDots();
}

// Draw bag-check / wristband / water lane boxes + server indicators
function drawLanes() {
  svg.selectAll('.dynamic-lanes').remove();
  const g = svg.append('g').attr('class', 'dynamic-lanes');

  // helper: draw a column of lanes
  function drawLaneColumn(cx, servers, label0) {
    const n    = servers.length;
    const lh   = LY.laneH / n - 4;
    const lw   = LY.boxW;

    servers.forEach((srv, i) => {
      const ly = LY.laneTop + i * (lh + 4);
      const isVIPLane = (cx === LY.xBag && i === 0);
      const stroke = isVIPLane ? '#f5c518' : '#2a2a4a';

      g.append('rect')
        .attr('class', 'lane-box')
        .attr('x', cx - lw/2).attr('y', ly)
        .attr('width', lw).attr('height', lh)
        .attr('rx', 4)
        .style('stroke', stroke);

      // server busy indicator
      const busy = srv.current !== null;
      g.append('circle')
        .attr('cx', cx).attr('cy', ly + lh/2)
        .attr('r', 8)
        .attr('fill', busy ? (isVIPLane ? '#f5c518' : '#7375de') : '#333')
        .attr('stroke', '#555').attr('stroke-width', 1);

      // lane label
      const lbl = isVIPLane ? 'VIP' : `L${i}`;
      g.append('text').attr('class', 'lane-label')
        .attr('x', cx - lw/2 + 18).attr('y', ly + 14)
        .attr('text-anchor', 'start')
        .text(lbl);

      // served count
      g.append('text').attr('class', 'lane-label')
        .attr('x', cx + lw/2 - 4).attr('y', ly + 14)
        .attr('text-anchor', 'end')
        .attr('fill', '#555')
        .text(`✓${srv.servedCount}`);
    });
  }

  drawLaneColumn(LY.xBag,   bagServers,   'Bag Check');
  drawLaneColumn(LY.xWrist, wristServers, 'Wristband');
  drawLaneColumn(LY.xWater, waterServers, 'Water');
}

// Queue count labels at the bottom of each column
function drawQueueBars() {
  svg.selectAll('.dynamic-bars').remove();
  const g = svg.append('g').attr('class', 'dynamic-bars');

  const counts = [
    { cx: LY.xHolding, label: `hold: ${holdingQueue.length}` },
    { cx: LY.xBag,     label: `q: ${bagQueueVIP.length + bagQueueNorm.length}` },
    { cx: LY.xWrist,   label: `q: ${wristQueue.length}` },
    { cx: LY.xWater,   label: `q: ${waterQueue.length}` },
    { cx: LY.xVenue,   label: `in: ${attendees.filter(a => a.state === S.ENTERED).length}`, color: '#4caf50' },
  ];

  counts.forEach(({ cx, label, color }) => {
    g.append('text').attr('class', 'lane-label')
      .attr('x', cx).attr('y', LY.qBarY)
      .attr('fill', color || '#888')
      .text(label);
  });
}

// Dot scatter — render dots inside each stage's lane box
function drawDots() {
  svg.selectAll('.dynamic-dots').remove();
  const g = svg.append('g').attr('class', 'dynamic-dots');

  // Map state → x column centre
  const stateX = {
    [S.ARRIVING]:    null,
    [S.HOLDING]:     LY.xHolding,
    [S.BAG_QUEUE]:   LY.xBag,
    [S.BAG_SVC]:     LY.xBag,
    [S.WRIST_QUEUE]: LY.xWrist,
    [S.WRIST_SVC]:   LY.xWrist,
    [S.WATER_QUEUE]: LY.xWater,
    [S.WATER_SVC]:   LY.xWater,
    [S.ENTERED]:     LY.xVenue,
  };

  const r    = 4;
  const pad  = 8;
  const bw   = LY.boxW - pad * 2;
  // dots live inside the lane box area
  const boxTop = LY.laneTop + pad;
  const boxH   = LY.laneH  - pad * 2;
  const dotsPerRow = Math.max(1, Math.floor(bw / (r * 2 + 3)));

  // group by column
  const byCol = d3.group(
    attendees.filter(a => stateX[a.state] !== null),
    a => stateX[a.state]
  );

  byCol.forEach((group, cx) => {
    // cap at what fits visually
    const maxDots = dotsPerRow * Math.floor(boxH / (r * 2 + 3));
    const shown   = group.slice(0, maxDots);

    shown.forEach((a, i) => {
      const col = i % dotsPerRow;
      const row = Math.floor(i / dotsPerRow);
      const x   = (cx - LY.boxW / 2) + pad + r + col * (r * 2 + 3);
      const y   = boxTop + r + row * (r * 2 + 3);

      g.append('circle')
        .attr('cx', x).attr('cy', y).attr('r', r)
        .attr('class', a.isVIP ? 'dot-vip' : (a.state === S.ENTERED ? 'dot-entered' : 'dot-normal'))
        .attr('opacity', 0.85);
    });
  });
}

// ═══════════════════════════════════════════════════════════
//  ANIMATION LOOP
// ═══════════════════════════════════════════════════════════
function loop(wallTime) {
  if (!isRunning) return;

  if (lastWall === null) lastWall = wallTime;
  const wallDt = (wallTime - lastWall) / 1000;  // real seconds elapsed
  lastWall = wallTime;

  const simDt = wallDt * CFG.simSpeed;           // sim seconds to advance
  simStep(simDt);
  updateStats();
  drawScene();

  // stop when all attendees have entered
  const done = attendees.every(a => a.state === S.ENTERED);
  if (done) {
    isRunning = false;
    document.getElementById('clock').textContent += '  ✓ Done';
    drawScene();
    return;
  }

  animFrame = requestAnimationFrame(loop);
}

// ═══════════════════════════════════════════════════════════
//  CONTROLS WIRING
// ═══════════════════════════════════════════════════════════
function wireControls() {
  function bind(id, cfgKey, transform, labelId, fmt) {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      CFG[cfgKey] = transform(el.value);
      if (labelId) document.getElementById(labelId).textContent = fmt ? fmt(el.value) : el.value;
    });
    // set initial label
    if (labelId) document.getElementById(labelId).textContent = fmt ? fmt(el.value) : el.value;
  }

  bind('cfg-total',          'totalAttendees', v => +v,        'val-total',          v => v);
  bind('cfg-vip-pct',        'vipPct',         v => +v/100,    'val-vip-pct',        v => v+'%');
  bind('cfg-arrival-window', 'arrivalWindow',  v => +v,        'val-arrival-window', v => v);
  bind('cfg-bag-pct',        'bagPct',         v => +v/100,    'val-bag-pct',        v => v+'%');
  bind('cfg-batch-size',     'batchSize',      v => +v,        'val-batch-size',     v => v);
  bind('cfg-batch-interval', 'batchInterval',  v => +v,        'val-batch-interval', v => v);
  bind('cfg-bag-lanes',      'bagLanes',       v => +v,        'val-bag-lanes',      v => v);
  bind('cfg-wrist',          'wristCounters',  v => +v,        'val-wrist',          v => v);
  bind('cfg-water',          'waterStations',  v => +v,        'val-water',          v => v);
  bind('cfg-wrist-pct',      'wristPct',       v => +v/100,    'val-wrist-pct',      v => v+'%');
  bind('cfg-water-pct',      'waterPct',       v => +v/100,    'val-water-pct',      v => v+'%');

  document.getElementById('cfg-vip-spillover').addEventListener('change', e => {
    CFG.vipSpillover = e.target.checked;
  });

  const speedSlider = document.getElementById('speed-slider');
  speedSlider.addEventListener('input', () => {
    CFG.simSpeed = +speedSlider.value;
    document.getElementById('speed-label').textContent = speedSlider.value + '×';
  });

  document.getElementById('btn-start').addEventListener('click', () => {
    if (!isRunning) {
      isRunning = true;
      lastWall  = null;
      animFrame = requestAnimationFrame(loop);
    }
  });

  document.getElementById('btn-pause').addEventListener('click', () => {
    isRunning = false;
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    reset();
  });
}

// ═══════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  wireControls();
  initCanvas();
  reset();
});

window.addEventListener('resize', () => {
  initCanvas();
  drawScene();
});
