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
      // Coords for movement across screen
      vx: null,
      vy: null,
      tx: null,
      ty: null,
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

  bagServers   = Array.from({length: CFG.bagLanes + 1}, () => ({ busyUntil: 0, servedCount: 0, current: null}));
  wristServers = Array.from({length: CFG.wristCounters},  () => ({ busyUntil: 0, servedCount: 0, current: null }));
  waterServers = Array.from({length: CFG.waterStations},  () => ({ busyUntil: 0, servedCount: 0, current: null }));

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

// Add layer variables for different parts of the animation
let staticLayer, laneLayer, barLayer, dotLayer, pulseLayer;

// lerp_speed is movement speed between areas
// can modify lerp value, higher = faster movement, lower = slower but smoother
const LERP_K = 0.08;

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
  
  // Layer order: static → lanes → pulse → bars → dots
  staticLayer = svg.append('g').attr('class', 'static-layer');
  laneLayer   = svg.append('g').attr('class', 'lane-layer');
  pulseLayer  = svg.append('g').attr('class', 'pulse-layer');
  barLayer    = svg.append('g').attr('class', 'bar-layer');
  dotLayer    = svg.append('g').attr('class', 'dot-layer');

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
  const g = staticLayer;
  g.selectAll('*').remove();

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
  updateDots();
  drawServerPulses();
}

// Draw bag-check / wristband / water lane boxes + server indicators
function drawLanes() {
  laneLayer.selectAll('*').remove();

  // helper: draw a column of lanes
  function drawLaneColumn(cx, servers) {
    const n    = servers.length;
    const lh   = LY.laneH / n - 4;
    const lw   = LY.boxW;

    servers.forEach((srv, i) => {
      const ly = LY.laneTop + i * (lh + 4);
      const isVIPLane = (cx === LY.xBag && i === 0);
      const stroke = isVIPLane ? '#f5c518' : '#2a2a4a';
      const busy = srv.current !== null;

      laneLayer.append('rect')
        .attr('class', 'lane-box')
        .attr('x', cx - lw/2).attr('y', ly)
        .attr('width', lw).attr('height', lh)
        .attr('rx', 4)
        .style('stroke', stroke);

      // server busy indicator
      laneLayer.append('circle')
        .attr('cx', cx).attr('cy', ly + lh/2)
        .attr('r', 8)
        .attr('fill', busy ? (isVIPLane ? '#f5c518' : '#7375de') : '#333')
        .attr('stroke', '#555').attr('stroke-width', 1);

      // lane label
      const lbl = isVIPLane ? 'VIP' : `L${i - 1}`;
      laneLayer.append('text').attr('class', 'lane-label')
        .attr('x', cx - lw/2 + 16).attr('y', ly + 8)
        .attr('text-anchor', 'start')
        .text(lbl);

      // served count
      laneLayer.append('text').attr('class', 'lane-label')
        .attr('x', cx + lw/2 - 12).attr('y', ly + 8)
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
  barLayer.selectAll('*').remove();

  const counts = [
    { cx: LY.xHolding, label: `hold: ${holdingQueue.length}` },
    { cx: LY.xBag,     label: `q: ${bagQueueVIP.length + bagQueueNorm.length}` },
    { cx: LY.xWrist,   label: `q: ${wristQueue.length}` },
    { cx: LY.xWater,   label: `q: ${waterQueue.length}` },
    { cx: LY.xVenue,   label: `in: ${attendees.filter(a => a.state === S.ENTERED).length}`, color: '#4caf50' },
  ];

  counts.forEach(({ cx, label, color }) => {
    barLayer.append('text').attr('class', 'lane-label')
      .attr('x', cx).attr('y', LY.qBarY)
      .attr('fill', color || '#888')
      .text(label);
  });
}

// new dots system , to improve movement of the dots
// maps each attendee state to a target coordinate on grid
// use lerp to move toward frame by frame
const r = 4;
const dotGap = r*2+3;

function stateColumn(state) {
  return {
    [S.HOLDING]:     LY.xHolding,
    [S.BAG_QUEUE]:   LY.xBag,
    [S.BAG_SVC]:     LY.xBag,
    [S.WRIST_QUEUE]: LY.xWrist,
    [S.WRIST_SVC]:   LY.xWrist,
    [S.WATER_QUEUE]: LY.xWater,
    [S.WATER_SVC]:   LY.xWater,
    [S.ENTERED]:     LY.xVenue,
  }[state] ?? null;
}

function computeTargets() {
  const pad = 8;
  const bw  = LY.boxW - pad * 2;

  // helper: place a group of attendees into N evenly-stacked sub-lane boxes
  function placeInLanes(group, cx, numLanes, assignLane) {
    const lh  = LY.laneH / numLanes - 4;
    const dpr = Math.max(1, Math.floor(bw / dotGap));
    const maxPerLane = dpr * Math.floor((lh - pad * 2) / dotGap);

    // bucket attendees into their lane
    const buckets = Array.from({ length: numLanes }, () => []);
    for (const a of group) {
      const lane = assignLane(a);
      buckets[lane].push(a);
    }

    buckets.forEach((bucket, laneIdx) => {
      const laneTop = LY.laneTop + laneIdx * (lh + 4) + pad;
      bucket.slice(0, maxPerLane).forEach((a, i) => {
        a.tx = (cx - LY.boxW / 2) + pad + r + (i % dpr) * dotGap;
        a.ty = laneTop + r + Math.floor(i / dpr) * dotGap;
      });
      bucket.slice(maxPerLane).forEach(a => { a.tx = null; a.ty = null; });
    });
  }

  // group visible attendees by column
  const cols = {};
  for (const a of attendees) {
    if (a.state === S.ARRIVING) continue;
    const cx = stateColumn(a.state);
    if (cx === null) continue;
    if (!cols[cx]) cols[cx] = [];
    cols[cx].push(a);
  }

  for (const [cxStr, group] of Object.entries(cols)) {
    const cx = +cxStr;

    if (cx === LY.xBag && bagServers.length > 1) {
      // Lane 0 = VIP, lanes 1..N = normal
      const n = bagServers.length;
      const normalCounts = Array(n - 1).fill(0);
      placeInLanes(group, cx, n, a => {
        if (a.isVIP) return 0;
        // assign to least full normal lane
        const laneOffset = normalCounts.indexOf(Math.min(...normalCounts));
        normalCounts[laneOffset]++;
        return laneOffset + 1;
      });

    } else if (cx === LY.xWrist && wristServers.length > 1) {
      const n = wristServers.length;
      const counts = Array(n).fill(0);
      placeInLanes(group, cx, n, () => {
        const lane = counts.indexOf(Math.min(...counts));
        counts[lane]++;
        return lane;
      });

    } else if (cx === LY.xWater && waterServers.length > 1) {
      const n = waterServers.length;
      const counts = Array(n).fill(0);
      placeInLanes(group, cx, n, () => {
        const lane = counts.indexOf(Math.min(...counts));
        counts[lane]++;
        return lane;
      });

    } else {
      // holding, venue, or single-lane columns: flat grid as before
      const boxH    = LY.laneH - pad * 2;
      const dpr     = Math.max(1, Math.floor(bw / dotGap));
      const maxDots = dpr * Math.floor(boxH / dotGap);
      group.slice(0, maxDots).forEach((a, i) => {
        a.tx = (cx - LY.boxW / 2) + pad + r + (i % dpr) * dotGap;
        a.ty = LY.laneTop + pad + r + Math.floor(i / dpr) * dotGap;
      });
      group.slice(maxDots).forEach(a => { a.tx = null; a.ty = null; });
    }
  }

  // arriving attendees: park off-canvas
  for (const a of attendees) {
    if (a.state === S.ARRIVING) { a.tx = null; a.ty = null; }
  }
}

function lerpDots() {
  for (const a of attendees) {
    if (a.tx === null || a.ty === null) {
      // snap to off-screen start position on first appearance
      a.vx = null; a.vy = null;
      continue;
    }
    if (a.vx === null || a.vy === null) {
      // first time visible: snap to target (no slide from nowhere)
      a.vx = a.tx;
      a.vy = a.ty;
    } else {
      a.vx += (a.tx - a.vx) * LERP_K;
      a.vy += (a.ty - a.vy) * LERP_K;
    }
  }
}

function updateDots() {
  computeTargets();
  lerpDots();

  const visible = attendees.filter(a => a.vx !== null && a.vy !== null);

  // added this to replace dots with people shaped objects
  const people = dotLayer.selectAll('g.attendee-person')
    .data(visible, d => d.id);

  const peopleEnter = people.enter().append('g')
    .attr('class', d => 'attendee-person ' + (d.isVIP ? 'dot-vip' : (d.state === S.ENTERED ? 'dot-entered' : 'dot-normal')))
    .attr('opacity', 0)
    .attr('transform', d => `translate(${d.vx},${d.vy})`);

  peopleEnter.append('circle')
    .attr('class', 'person-head')
    .attr('cx', 0)
    .attr('cy', -2.6)
    .attr('r', 2.1)
    .attr('fill', 'currentColor');

  peopleEnter.append('line')
    .attr('class', 'person-torso')
    .attr('x1', 0)
    .attr('y1', 0.2)
    .attr('x2', 0)
    .attr('y2', 4.8)
    .attr('stroke', 'currentColor')
    .attr('stroke-width', 1.5)
    .attr('stroke-linecap', 'round');

  peopleEnter
    .merge(people)
    .attr('class', d => 'attendee-person ' + (d.isVIP ? 'dot-vip' : (d.state === S.ENTERED ? 'dot-entered' : 'dot-normal')))
    .attr('transform', d => `translate(${d.vx},${d.vy})`)
    .attr('opacity', 0.85);

  people.exit().remove();
}

// server pulse system, to add some animation for them pulsing when busy

let pulsePhase = 0;  // 0..1, advanced each drawScene call

function drawServerPulses() {
  pulseLayer.selectAll('*').remove();

  // advance phase by a fixed small amount each frame
  pulsePhase = (pulsePhase + 0.018) % 1;

  function pulseColumn(cx, servers) {
    const n  = servers.length;
    const lh = LY.laneH / n - 4;
    servers.forEach((srv, i) => {
      if (!srv.current) return;
      const ly  = LY.laneTop + i * (lh + 4);
      const cy  = ly + lh / 2;
      const isVIP = (cx === LY.xBag && i === 0);
      const color = isVIP ? '#f5c518' : '#7375de';

      // two rings offset by half a cycle for a continuous pulse
      [0, 0.5].forEach(offset => {
        const p = (pulsePhase + offset) % 1;
        const rr = 8 + p * 18;
        const op = (1 - p) * 0.55;
        pulseLayer.append('circle')
          .attr('cx', cx).attr('cy', cy)
          .attr('r', rr)
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', 1.5)
          .attr('opacity', op);
      });
    });
  }

  pulseColumn(LY.xBag,   bagServers);
  pulseColumn(LY.xWrist, wristServers);
  pulseColumn(LY.xWater, waterServers);
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
    // sync CFG to slider's initial HTML value on load
    CFG[cfgKey] = transform(el.value);
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
