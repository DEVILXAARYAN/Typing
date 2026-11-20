/*
 * TypeArena race scene: a landscape where every player is a stick figure running toward the finish.
 * It only draws what the game already knows (each player's progress and speed). The kicks and punches when
 * someone overtakes are for show: they never change a position or a score.
 *
 * Worlds: dusk, snow, neon, space.  Looks (colour, hat, trail) are cosmetic and come from the players' accounts.
 *
 * Browser:  var scene = TypeScene.createScene(canvas, { world: 'dusk', getData: function () { return {...}; } }); scene.start();
 * Tests:    scene.frame(dt) advances and draws one frame (works with any 2D canvas, e.g. @napi-rs/canvas).
 *
 * getData() returns { running: bool, refWpm: number,
 *                     players: [{ id, name, me, bot, pct, wpm, finished, finishMs, look: { color, hat, trail } }] }
 */
(function (root) {
  'use strict';
  var TAU = Math.PI * 2;
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var smooth = function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  var ME = '#C6FF3D';
  var PALETTE = ['#FF8A8A', '#6FE3FF', '#FFB35C', '#B9A6FF', '#FF9FD2', '#7CF0B5', '#FFE066', '#8FB8FF', '#FF7AE0'];
  var COLORS = { lime: ME, aqua: '#6FE3FF', coral: '#FF8A8A', violet: '#B9A6FF', amber: '#FFB35C', pink: '#FF9FD2', gold: '#FFD76A' }; // "rainbow" cycles through hues
  var HIT_WORDS = ['Pow!', 'Bam!', 'Wham!', 'Zap!'];
  var WORLD_NAMES = { dusk: 'Dusk Hills', snow: 'Snowfield', neon: 'Neon City', space: 'Deep Space' };

  function createScene(canvas, opts) {
    opts = opts || {};
    var ctx = canvas && canvas.getContext && canvas.getContext('2d');
    if (!ctx) { var no = function () {}; return { supported: false, start: no, stop: no, frame: no, resize: no, autosize: no, stumble: no, setStreak: no, setWorld: no, getWorld: function () { return 'dusk'; }, summary: function () { return ''; } }; }

    var makeCanvas = opts.makeCanvas || function (w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    var W = 680, H = 300, dpr = 1, groundTop = 150, startX = 34, finishX = 580;
    var world = WORLD_NAMES[opts.world] ? opts.world : 'dusk', T = null;
    var runners = {}, order = [], fights = [], bursts = [], overtake = {};
    var scroll = 0, speed = 0, time = 0, raceT = 0, raf = 0, last = 0;
    var data = { running: false, refWpm: 0, players: [] };

    // ---------- layout ----------
    function resize(w, h, ratio) {
      W = Math.max(280, Math.round(w)); H = Math.max(130, Math.round(h)); dpr = ratio || 1;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      if (canvas.style) { canvas.style.width = W + 'px'; canvas.style.height = H + 'px'; }
      groundTop = Math.round(H * 0.5); startX = Math.round(W * 0.05); finishX = Math.round(W - Math.max(78, W * 0.15));
      T = WORLDS[world](); layoutLanes();
    }
    function autosize() {
      var w = (canvas.parentNode && canvas.parentNode.clientWidth) || 680;
      var vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      var h = clamp(Math.round(w * 0.44), 150, 300); if (vh < 620) h = Math.min(h, 150);
      resize(w, h, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    }
    function setWorld(id) { if (!WORLD_NAMES[id] || id === world) return; world = id; T = WORLDS[world](); }

    // ---------- background building blocks (each is drawn once into a cached layer) ----------
    function layer(w, h) { return makeCanvas(w, h); }
    function skyLayer(stops) {
      var c = layer(W, groundTop), g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, groundTop);
      stops.forEach(function (st) { gr.addColorStop(st[0], st[1]); }); g.fillStyle = gr; g.fillRect(0, 0, W, groundTop); return c;
    }
    function pine(g, x, y, h, color, snow) {
      for (var k = 0; k < 3; k++) {
        var w = h * (0.36 - k * 0.07), top = y - h + k * h * 0.27, bot = y - h * 0.62 + k * h * 0.27 + h * 0.2;
        g.fillStyle = color; g.beginPath(); g.moveTo(x, top); g.lineTo(x + w, bot); g.lineTo(x - w, bot); g.closePath(); g.fill();
        if (snow) { g.fillStyle = snow; g.beginPath(); g.moveTo(x, top); g.lineTo(x + w * 0.55, top + (bot - top) * 0.5); g.lineTo(x - w * 0.55, top + (bot - top) * 0.5); g.closePath(); g.fill(); }
      }
    }
    // rolling hills that repeat seamlessly (whole-number frequencies)
    function hillsTile(baseF, ampF, freqs, phases, color, trees, seed) {
      var c = layer(W, groundTop), g = c.getContext('2d'), r = rng(seed), ys = [], base = groundTop * baseF, amp = groundTop * ampF;
      for (var x = 0; x <= W; x += 4) { var y = base; for (var k = 0; k < freqs.length; k++) y -= amp * (0.55 / (k + 1)) * Math.sin(TAU * freqs[k] * x / W + phases[k]); ys.push(y); }
      g.fillStyle = color; g.beginPath(); g.moveTo(0, groundTop);
      for (var i = 0; i < ys.length; i++) g.lineTo(i * 4, ys[i]);
      g.lineTo(W, groundTop); g.closePath(); g.fill();
      if (trees) {
        var n = Math.max(6, Math.round(W / 55)), sc = H / 300 + 0.4;
        for (var t = 0; t < n; t++) {
          var tx = ((t + r()) / n) * W, ty = ys[Math.min(ys.length - 1, Math.round(tx / 4))] + 2, th = (8 + r() * 12) * sc;
          if (trees.pine) pine(g, tx, ty, th * 1.7, trees.color, trees.snow);
          else { g.fillStyle = trees.color; g.beginPath(); g.moveTo(tx, ty - th); g.lineTo(tx + th * 0.32, ty); g.lineTo(tx - th * 0.32, ty); g.closePath(); g.fill(); }
        }
      }
      return c;
    }
    function mountainsTile(color, cap, seed) {
      var c = layer(W, groundTop), g = c.getContext('2d'), r = rng(seed), n = Math.max(4, Math.round(W / 130));
      for (var i = 0; i < n; i++) {
        var cx = ((i + 0.3 + r() * 0.4) / n) * W, h = groundTop * (0.28 + r() * 0.22), hw = h * (0.9 + r() * 0.5);
        [-W, 0, W].forEach(function (off) {
          g.fillStyle = color; g.beginPath(); g.moveTo(cx + off - hw, groundTop); g.lineTo(cx + off, groundTop - h); g.lineTo(cx + off + hw, groundTop); g.closePath(); g.fill();
          g.fillStyle = cap; g.beginPath(); g.moveTo(cx + off, groundTop - h); g.lineTo(cx + off + hw * 0.34, groundTop - h * 0.62);
          g.lineTo(cx + off + hw * 0.12, groundTop - h * 0.7); g.lineTo(cx + off - hw * 0.1, groundTop - h * 0.6); g.lineTo(cx + off - hw * 0.34, groundTop - h * 0.62); g.closePath(); g.fill();
        });
      }
      return c;
    }
    function skylineTile(color, seed, minH, maxH, winAlpha, signs) {
      var c = layer(W, groundTop), g = c.getContext('2d'), r = rng(seed), x = 0, win = ['#FFE66D', '#7DF9FF', '#FF6FD8', '#FFFFFF'], neon = ['#FF2E88', '#2DE2E6', '#B517D8', '#FFE45E'];
      while (x < W) {
        var bw = 14 + r() * 26, bh = (minH + r() * (maxH - minH)) * groundTop; if (x + bw > W) bw = W - x;
        g.fillStyle = color; g.fillRect(x, groundTop - bh, bw, bh);
        for (var wy = groundTop - bh + 5; wy < groundTop - 4; wy += 7) for (var wx = x + 3; wx < x + bw - 3; wx += 6)
          if (r() < 0.32) { g.fillStyle = win[Math.floor(r() * win.length)]; g.globalAlpha = winAlpha * (0.45 + r() * 0.55); g.fillRect(wx, wy, 2.5, 3.5); }
        g.globalAlpha = 1;
        if (r() < 0.22) { g.fillStyle = color; g.fillRect(x + bw / 2 - 0.8, groundTop - bh - 10, 1.6, 10); }
        if (signs && r() < 0.4) { var nc = neon[Math.floor(r() * neon.length)]; g.fillStyle = nc; g.shadowColor = nc; g.shadowBlur = 8; g.fillRect(x + 3, groundTop - bh + 4 + r() * bh * 0.55, Math.max(4, bw - 6), 2); g.shadowBlur = 0; }
        x += bw + (r() < 0.3 ? 4 : 0);
      }
      return c;
    }
    function starField(n, seed, maxY) { var r = rng(seed), a = []; for (var i = 0; i < n; i++) a.push({ x: r() * W, y: r() * maxY, p: r() * TAU, s: 0.7 + r() * 1.2 }); return a; }
    function drawStars(g, list, t, scrollF) {
      for (var i = 0; i < list.length; i++) { var st = list[i], x = ((st.x - scroll * scrollF) % W + W) % W; g.globalAlpha = 0.4 + 0.45 * Math.sin(t * 1.4 + st.p); g.fillStyle = '#fff'; g.fillRect(x, st.y, st.s, st.s); }
      g.globalAlpha = 1;
    }

    // ---------- the four worlds ----------
    var WORLDS = {
      dusk: function () {
        var stars = starField(26, 5, groundTop * 0.62);
        return {
          sky: skyLayer([[0, '#2B2766'], [1, '#F08A6B']]),
          far: hillsTile(0.82, 0.2, [1, 3, 5], [0.4, 1.7, 0.2], '#4F4590', null, 11),
          near: hillsTile(0.93, 0.12, [2, 4, 7], [1.1, 0.3, 2.4], '#382F72', { color: '#2B235A' }, 23),
          ground: '#231F4D', edge: '#5C52A8', lane: '#4A4380', outline: 'rgba(8,6,28,0.55)', shadow: 'rgba(0,0,0,0.28)', bob: 1,
          back: function (g, t) {
            drawStars(g, stars, t, 0);
            g.fillStyle = '#FFD27A'; g.beginPath(); g.arc(W * 0.74, groundTop * 0.86, H * 0.1, 0, TAU); g.fill();
            g.fillStyle = 'rgba(255,255,255,0.14)';
            for (var c = 0; c < 3; c++) { var cx = ((c * W * 0.42 - scroll * 0.05) % (W + 160) + (W + 160)) % (W + 160) - 80; g.beginPath(); g.ellipse(cx, groundTop * (0.22 + c * 0.13), 48, 9, 0, 0, TAU); g.fill(); }
          }
        };
      },
      snow: function () {
        var flakes = [], r = rng(31); for (var i = 0; i < 80; i++) flakes.push({ x: r() * W, y: r() * H, v: 18 + r() * 34, r: 0.8 + r() * 1.7, p: r() * TAU });
        return {
          sky: skyLayer([[0, '#6FA8E3'], [1, '#EAF4FD']]),
          far: mountainsTile('#9DB6DA', '#FFFFFF', 3),
          near: hillsTile(0.93, 0.12, [2, 4, 7], [1.1, 0.3, 2.4], '#D6E5F3', { pine: true, color: '#2F6A73', snow: '#F5FAFF' }, 23),
          ground: '#EEF5FB', edge: '#FFFFFF', lane: '#B5CAE0', outline: 'rgba(20,28,60,0.62)', shadow: 'rgba(40,70,120,0.22)', bob: 0.85,
          back: function (g) {
            g.fillStyle = 'rgba(255,248,214,0.35)'; g.beginPath(); g.arc(W * 0.74, groundTop * 0.5, H * 0.13, 0, TAU); g.fill();
            g.fillStyle = '#FFF6D6'; g.beginPath(); g.arc(W * 0.74, groundTop * 0.5, H * 0.07, 0, TAU); g.fill();
            g.fillStyle = 'rgba(255,255,255,0.55)';
            for (var c = 0; c < 3; c++) { var cx = ((c * W * 0.42 - scroll * 0.05) % (W + 160) + (W + 160)) % (W + 160) - 80; g.beginPath(); g.ellipse(cx, groundTop * (0.2 + c * 0.14), 52, 10, 0, 0, TAU); g.fill(); }
          },
          step: function (dt, sp) { for (var i = 0; i < flakes.length; i++) { var f = flakes[i]; f.y += f.v * dt; f.x -= (sp * 0.18 + Math.sin(time + f.p) * 6) * dt; if (f.y > H) { f.y = -4; f.x = Math.random() * W; } if (f.x < -4) f.x = W + 4; } },
          front: function (g) { g.fillStyle = 'rgba(255,255,255,0.85)'; for (var i = 0; i < flakes.length; i++) { var f = flakes[i]; g.beginPath(); g.arc(f.x, f.y, f.r, 0, TAU); g.fill(); } }
        };
      },
      neon: function () {
        var stars = starField(18, 9, groundTop * 0.5);
        return {
          sky: skyLayer([[0, '#06031A'], [0.55, '#2A0B52'], [1, '#D1177F']]),
          far: skylineTile('#1D0B3F', 7, 0.18, 0.42, 0.55, false),
          near: skylineTile('#12072B', 9, 0.22, 0.62, 0.9, true),
          ground: '#120929', edge: '#FF2E88', lane: '#2DE2E6', outline: 'rgba(0,0,0,0.7)', shadow: 'rgba(255,46,136,0.25)', bob: 1,
          back: function (g, t) {
            drawStars(g, stars, t, 0);
            var cx = W * 0.5, cy = groundTop * 0.9, r = Math.min(H * 0.24, W * 0.16);
            var gr = g.createLinearGradient(0, cy - r, 0, cy + r); gr.addColorStop(0, '#FFE45E'); gr.addColorStop(0.5, '#FF5FA2'); gr.addColorStop(1, '#B517D8');
            g.save(); g.beginPath(); g.rect(0, 0, W, groundTop); g.clip(); g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
            g.fillStyle = '#2A0B52'; for (var i = 0; i < 6; i++) g.fillRect(cx - r, cy + r * 0.08 + i * r * 0.17, 2 * r, 1 + i * 1.1);
            g.restore();
          },
          deco: function (g) { // a glowing grid on the road
            g.strokeStyle = 'rgba(255,46,136,0.28)'; g.lineWidth = 1;
            for (var i = 1; i < 7; i++) { var y = groundTop + (H - groundTop) * Math.pow(i / 7, 1.5); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
            g.strokeStyle = 'rgba(45,226,230,0.18)';
            for (var x = -(scroll % 60); x < W; x += 60) { g.beginPath(); g.moveTo(x, groundTop); g.lineTo(x - 16, H); g.stroke(); }
          }
        };
      },
      space: function () {
        var near = starField(40, 13, groundTop * 0.95), farS = starField(60, 17, groundTop * 0.95), craters = [], r = rng(41), shooting = null, nextShot = 2;
        for (var i = 0; i < 9; i++) craters.push({ x: r() * W, y: 0.15 + r() * 0.75, rx: 10 + r() * 26, ry: 2.5 + r() * 5 });
        var sky = skyLayer([[0, '#01020B'], [0.6, '#0C0E33'], [1, '#27185A']]), g = sky.getContext('2d');
        [[0.25, 0.55, 0.4, 'rgba(190,60,200,0.22)'], [0.62, 0.3, 0.34, 'rgba(60,150,255,0.18)']].forEach(function (nb) {
          var rad = g.createRadialGradient(W * nb[0], groundTop * nb[1], 0, W * nb[0], groundTop * nb[1], W * nb[2]); rad.addColorStop(0, nb[3]); rad.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = rad; g.fillRect(0, 0, W, groundTop);
        });
        var px = W * 0.78, py = groundTop * 0.4, pr = Math.min(H * 0.2, W * 0.12);
        g.strokeStyle = 'rgba(210,190,255,0.55)'; g.lineWidth = Math.max(2, pr * 0.1); g.beginPath(); g.ellipse(px, py, pr * 1.75, pr * 0.42, -0.35, Math.PI, TAU); g.stroke(); // back half of the ring
        var pg = g.createRadialGradient(px - pr * 0.35, py - pr * 0.35, pr * 0.1, px, py, pr); pg.addColorStop(0, '#FFB98A'); pg.addColorStop(0.6, '#C96A8E'); pg.addColorStop(1, '#4A2A6A');
        g.fillStyle = pg; g.beginPath(); g.arc(px, py, pr, 0, TAU); g.fill();
        g.beginPath(); g.ellipse(px, py, pr * 1.75, pr * 0.42, -0.35, 0, Math.PI); g.stroke(); // front half of the ring
        g.fillStyle = '#C9CBE8'; g.beginPath(); g.arc(W * 0.14, groundTop * 0.3, pr * 0.3, 0, TAU); g.fill(); g.fillStyle = 'rgba(40,40,90,0.35)'; g.beginPath(); g.arc(W * 0.14 + pr * 0.1, groundTop * 0.3 + pr * 0.05, pr * 0.12, 0, TAU); g.fill();
        return {
          sky: sky,
          far: hillsTile(0.86, 0.1, [1, 2, 4], [0.9, 2.1, 0.5], '#1E1D4F', null, 51),
          near: hillsTile(0.95, 0.08, [3, 5, 8], [0.2, 1.3, 2.9], '#2A2766', null, 53),
          ground: '#2B2862', edge: '#7F7BFF', lane: '#4DE3FF', outline: 'rgba(2,2,20,0.7)', shadow: 'rgba(0,0,0,0.35)', bob: 1.5,
          back: function (g, t) { drawStars(g, farS, t, 0.01); drawStars(g, near, t * 1.3, 0.04); },
          deco: function (g) { g.strokeStyle = 'rgba(160,160,255,0.28)'; g.lineWidth = 1; craters.forEach(function (c) { var x = ((c.x - scroll) % W + W) % W; g.beginPath(); g.ellipse(x, groundTop + (H - groundTop) * c.y, c.rx, c.ry, 0, 0, TAU); g.stroke(); }); },
          step: function (dt) { nextShot -= dt; if (!shooting && nextShot <= 0) { shooting = { x: W * (0.3 + Math.random() * 0.6), y: Math.random() * groundTop * 0.4, t: 0 }; nextShot = 3 + Math.random() * 4; } if (shooting) { shooting.t += dt; if (shooting.t > 0.7) shooting = null; } },
          front: function (g) { if (!shooting) return; var k = shooting.t / 0.7, x = shooting.x - k * 160, y = shooting.y + k * 60; g.strokeStyle = 'rgba(255,255,255,' + (1 - k) + ')'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 44, y - 16); g.stroke(); }
        };
      }
    };

    // ---------- runners ----------
    function figureScale() { var n = Math.max(1, order.length); return (H / 300) * clamp(1.5 - 0.08 * n, 0.78, 1.25); }
    function laneY(idx, n) {
      var top = groundTop + (H - groundTop) * 0.34, bottom = H - Math.max(8, H * 0.035);
      return n <= 1 ? (top + bottom) / 2 : top + (bottom - top) * (idx / (n - 1));
    }
    function layoutLanes() { var n = order.length; order.forEach(function (id, i) { runners[id].laneY = laneY(i, n); }); }
    function sync() {
      var ids = data.players.map(function (p) { return p.id; });
      var changed = ids.length !== order.length || ids.some(function (id) { return !runners[id]; });
      if (changed) {
        var rest = data.players.filter(function (p) { return !p.me; }).map(function (p) { return p.id; }).sort();
        var mine = data.players.filter(function (p) { return p.me; }).map(function (p) { return p.id; });
        order = rest.concat(mine); // you run in the front lane
        Object.keys(runners).forEach(function (id) { if (ids.indexOf(id) < 0) delete runners[id]; });
        order.forEach(function (id) {
          if (!runners[id]) runners[id] = { id: id, px: 0, wpm: 0, phase: Math.random() * TAU, stumbleT: 0, streak: 0, cool: 0, fight: null, dx: 0, dy: 0, laneY: 0, post: 0 };
        });
        layoutLanes(); fights = []; bursts = [];
      }
      data.players.forEach(function (p) {
        var r = runners[p.id]; if (!r) return;
        r.name = p.name || ''; r.me = !!p.me; r.bot = !!p.bot; r.target = clamp((p.pct || 0) / 100, 0, 1);
        r.wpmT = p.wpm || 0; r.finished = !!p.finished; r.finishMs = p.finishMs;
        var look = p.look || {}; r.hat = look.hat || 'none'; r.trail = look.trail || 'lines';
        r.rainbow = look.color === 'rainbow';
        r.color = COLORS[look.color] || (r.me ? ME : PALETTE[Math.max(0, order.indexOf(p.id)) % PALETTE.length]);
      });
    }
    function runnerX(r) { return lerp(startX, finishX + 12, r.px); }

    // ---------- fights (for show only) ----------
    function startFight(passer, passed) { // the runner who just got passed hits back first, then the passer turns and answers
      var s = figureScale();
      if (fights.length >= 3 || passer.fight || passed.fight || passer.cool > 0 || passed.cool > 0) return;
      var f = { a: passer, b: passed, t: 0, dur: 1.05, words: [HIT_WORDS[Math.floor(Math.random() * 4)], HIT_WORDS[Math.floor(Math.random() * 4)]], hit: [false, false], s: s };
      passer.fight = f; passed.fight = f; fights.push(f);
    }
    function updateFights(dt) {
      fights = fights.filter(function (f) {
        f.t += dt;
        var ax = runnerX(f.a), bx = runnerX(f.b), mx = (ax + bx) / 2, my = (f.a.laneY + f.b.laneY) / 2, s = f.s;
        var blend = smooth(f.t / 0.18) * (1 - smooth((f.t - (f.dur - 0.22)) / 0.22));
        f.a.dx = (mx + 13 * s - ax) * blend; f.b.dx = (mx - 13 * s - bx) * blend;
        f.a.dy = (my - f.a.laneY) * blend; f.b.dy = (my - f.b.laneY) * blend;
        var cx = mx, cy = my - 56 * s;
        if (!f.hit[0] && f.t >= 0.2) { f.hit[0] = true; bursts.push({ x: cx, y: cy, t: 0, word: f.words[0], s: s }); }
        if (!f.hit[1] && f.t >= 0.68) { f.hit[1] = true; bursts.push({ x: cx, y: cy, t: 0, word: f.words[1], s: s }); }
        if (f.t >= f.dur) { f.a.fight = f.b.fight = null; f.a.dx = f.b.dx = f.a.dy = f.b.dy = 0; f.a.cool = f.b.cool = 2.4; return false; }
        return true;
      });
      bursts = bursts.filter(function (b) { b.t += dt; return b.t < 0.55; });
    }
    function detectOvertakes() {
      var ids = order, i, j;
      for (i = 0; i < ids.length; i++) for (j = i + 1; j < ids.length; j++) {
        var a = runners[ids[i]], b = runners[ids[j]], key = a.id + '|' + b.id;
        var d = (a.px - b.px) * (finishX - startX);
        var prev = overtake[key] || 0, cur = prev;
        if (d > 6) cur = 1; else if (d < -6) cur = -1;
        if (prev !== 0 && cur !== prev && raceT > 1.2 && !a.finished && !b.finished) { if (cur === 1) startFight(a, b); else startFight(b, a); }
        overtake[key] = cur;
      }
    }

    // ---------- drawing the figures ----------
    function limb(g, ox, oy, a1, l1, a2, l2) {
      var kx = ox + Math.sin(a1) * l1, ky = oy + Math.cos(a1) * l1;
      g.moveTo(ox, oy); g.lineTo(kx, ky); g.lineTo(kx + Math.sin(a2) * l2, ky + Math.cos(a2) * l2);
    }
    function poseAngles(kind, ph, t, wpmF, bobK) {
      var sp = Math.sin(ph), cp = Math.cos(ph), sq = Math.sin(ph + Math.PI), cq = Math.cos(ph + Math.PI);
      switch (kind) {
        case 'run': return { lean: 0.12 + 0.1 * wpmF, bob: -Math.abs(sp) * 2.4 * bobK,
          l1: [0.8 * sp, 0.8 * sp - (0.15 + 1.0 * Math.max(0, cp))], l2: [0.8 * sq, 0.8 * sq - (0.15 + 1.0 * Math.max(0, cq))],
          a1: [-0.85 * sp, -0.85 * sp + 1.2], a2: [-0.85 * sq, -0.85 * sq + 1.2] };
        case 'kick': return { lean: -0.18, bob: 0, l1: [-0.1, -0.12], l2: [1.4, 1.5], a1: [0.4, 1.9], a2: [-0.5, 0.9] };
        case 'punch': return { lean: 0.1, bob: 0, l1: [0.45, 0.45], l2: [-0.35, -0.4], a1: [1.55, 1.55], a2: [0.5, 1.9] };
        case 'recoil': return { lean: -0.4, bob: 0, l1: [-0.5, -0.6], l2: [0.3, 0.2], a1: [-1.0, -1.7], a2: [-0.4, -1.4] };
        case 'stumble': return { lean: 0.55, bob: 0, l1: [0.9, 0.3], l2: [-0.6, -0.7], a1: [1.2, 1.8], a2: [0.7, 1.2] };
        case 'cheer': return { lean: 0, bob: -Math.abs(Math.sin(t * 9)) * 6 * bobK, l1: [0.15, 0.15], l2: [-0.15, -0.15], a1: [2.7, 2.9], a2: [-2.7, -2.9] };
        default: return { lean: 0.02, bob: Math.sin(t * 2.2) * 0.6, l1: [0.1, 0.1], l2: [-0.1, -0.1], a1: [0.12, 0.3], a2: [-0.12, 0.2] };
      }
    }
    // hats sit on the head; (0, -24s) is the middle of the head and 5.6s its radius, drawn in the leaning body frame
    function drawHat(g, hat, s) {
      var hy = -24 * s, hr = 5.6 * s;
      if (hat === 'cap') {
        g.fillStyle = '#E2495B'; g.beginPath(); g.arc(0, hy - 0.6 * s, hr * 1.12, Math.PI, TAU); g.closePath(); g.fill();
        g.fillStyle = '#B8283C'; g.fillRect(1 * s, hy - 1.4 * s, hr * 1.9, 1.9 * s);
      } else if (hat === 'headband') {
        g.fillStyle = '#FF4D6D'; g.fillRect(-hr * 1.05, hy - 2.4 * s, hr * 2.1, 2.1 * s);
        g.strokeStyle = '#FF4D6D'; g.lineWidth = 1.6 * s; g.lineCap = 'round'; g.beginPath(); g.moveTo(-hr, hy - 1.4 * s); g.lineTo(-hr - 5 * s, hy - 0.5 * s + Math.sin(time * 10) * 1.2 * s); g.moveTo(-hr, hy - 1.4 * s); g.lineTo(-hr - 4.5 * s, hy - 3.2 * s + Math.sin(time * 10 + 1) * 1.2 * s); g.stroke();
      } else if (hat === 'tophat') {
        g.fillStyle = '#3A3A5C'; g.strokeStyle = '#B9B9E6'; g.lineWidth = Math.max(0.8, 0.9 * s);
        g.fillRect(-hr * 1.25, hy - hr - 1.2 * s, hr * 2.5, 1.9 * s); g.strokeRect(-hr * 1.25, hy - hr - 1.2 * s, hr * 2.5, 1.9 * s);
        g.fillRect(-hr * 0.8, hy - hr - 9.5 * s, hr * 1.6, 9 * s); g.strokeRect(-hr * 0.8, hy - hr - 9.5 * s, hr * 1.6, 9 * s);
        g.fillStyle = '#FF4D6D'; g.fillRect(-hr * 0.8, hy - hr - 3.4 * s, hr * 1.6, 2 * s);
      } else if (hat === 'wizard') {
        g.fillStyle = '#6B4EFF'; g.beginPath(); g.moveTo(-hr * 1.05, hy - hr * 0.7); g.lineTo(hr * 1.05, hy - hr * 0.7); g.lineTo(2.6 * s, hy - hr - 11 * s); g.closePath(); g.fill();
        g.fillStyle = '#4B35C9'; g.beginPath(); g.ellipse(0, hy - hr * 0.7, hr * 1.55, 1.7 * s, 0, 0, TAU); g.fill();
        g.fillStyle = '#FFE066'; g.beginPath(); g.arc(0.5 * s, hy - hr - 3.5 * s, 1.1 * s, 0, TAU); g.fill();
      } else if (hat === 'halo') {
        g.strokeStyle = '#FFE066'; g.lineWidth = 1.7 * s; g.shadowColor = '#FFE066'; g.shadowBlur = 6; g.beginPath(); g.ellipse(0, hy - hr - 3.2 * s + Math.sin(time * 3) * 0.8 * s, hr * 1.1, 1.8 * s, 0, 0, TAU); g.stroke(); g.shadowBlur = 0;
      }
    }
    function drawFigure(g, x, y, s, color, kind, ph, t, facing, wpmF, hat) {
      var p = poseAngles(kind, ph, t, wpmF, T.bob), hipY = -22 * s, u = 11 * s;
      g.save(); g.translate(x, y + p.bob * s); if (facing < 0) g.scale(-1, 1);
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (var pass = 0; pass < 2; pass++) {
        g.strokeStyle = pass === 0 ? T.outline : color; g.fillStyle = g.strokeStyle;
        g.lineWidth = pass === 0 ? Math.max(2.4, 3.2 * s) + 2.2 : Math.max(2, 3.2 * s);
        g.beginPath(); limb(g, 0, hipY, p.l1[0], u, p.l1[1], u); limb(g, 0, hipY, p.l2[0], u, p.l2[1], u); g.stroke();
        g.save(); g.translate(0, hipY); g.rotate(p.lean);
        g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -17 * s); g.stroke();
        g.beginPath(); limb(g, 0, -17 * s, p.a1[0], 8 * s, p.a1[1], 8 * s); limb(g, 0, -17 * s, p.a2[0], 8 * s, p.a2[1], 8 * s); g.stroke();
        g.beginPath(); g.arc(0, -24 * s, (pass === 0 ? 6.4 : 5.6) * s + (pass === 0 ? 1 : 0), 0, TAU); g.fill();
        if (pass === 1 && hat && hat !== 'none') drawHat(g, hat, s);
        g.restore();
      }
      g.restore();
    }
    // ---------- trails: what streams out behind a runner ----------
    function drawTrail(g, r, x, y, s) {
      var L, i, k, q;
      if (r.trail === 'sparkles') {
        for (i = 0; i < 9; i++) {
          var ph = time * 3 + i * 1.7, px = x - (14 + i * 8 + (ph * 6) % 9) * s, py = y - (8 + (i * 13) % 42) * s + Math.sin(ph) * 3 * s, z = (2 + (i % 3)) * s * (0.6 + 0.4 * Math.sin(ph * 2));
          g.fillStyle = i % 2 ? '#FFF2A8' : '#FFFFFF'; g.globalAlpha = 0.85 - i * 0.07;
          g.beginPath(); g.moveTo(px, py - z * 1.6); g.lineTo(px + z * 0.4, py); g.lineTo(px, py + z * 1.6); g.lineTo(px - z * 0.4, py); g.closePath(); g.fill();
          g.beginPath(); g.moveTo(px - z * 1.6, py); g.lineTo(px, py + z * 0.4); g.lineTo(px + z * 1.6, py); g.lineTo(px, py - z * 0.4); g.closePath(); g.fill();
        }
        g.globalAlpha = 1;
      } else if (r.trail === 'flames') {
        for (i = 0; i < 6; i++) {
          g.fillStyle = i < 2 ? '#FFD27A' : i < 4 ? '#FF8A3C' : '#E8442C'; g.globalAlpha = 0.9 - i * 0.12;
          g.beginPath(); g.arc(x - (14 + i * 7.5) * s, y - 13 * s + Math.sin(time * 20 + i * 2) * 3.5 * s, Math.max(2, 9.5 - i * 1.3) * s, 0, TAU); g.fill();
        }
        g.globalAlpha = 1;
      } else if (r.trail === 'ribbon') {
        g.lineCap = 'round';
        for (k = 0; k < 22; k++) {
          g.strokeStyle = 'hsl(' + ((k * 16 + time * 90) % 360) + ',95%,62%)'; g.lineWidth = Math.max(1.6, (7 - k * 0.22) * s); g.globalAlpha = 0.95 - k * 0.03;
          var xa = x - (12 + k * 3.4) * s, xb = x - (12 + (k + 1) * 3.4) * s;
          g.beginPath(); g.moveTo(xa, y - 22 * s + Math.sin(time * 9 - k * 0.55) * 4 * s); g.lineTo(xb, y - 22 * s + Math.sin(time * 9 - (k + 1) * 0.55) * 4 * s); g.stroke();
        }
        g.globalAlpha = 1;
      } else if (r.trail === 'lightning') {
        var seed = rng(Math.floor(time * 14) * 7919 + (r.id.length * 31));
        for (q = 0; q < 2; q++) {
          var bx = x - 14 * s, by = y - (14 + q * 16) * s; g.beginPath(); g.moveTo(bx, by);
          for (k = 1; k <= 5; k++) { bx -= (6 + seed() * 6) * s; by += (seed() - 0.5) * 12 * s; g.lineTo(bx, by); }
          g.strokeStyle = 'rgba(122,215,255,0.55)'; g.lineWidth = 4.5 * s; g.stroke(); g.strokeStyle = '#FFF27A'; g.lineWidth = 1.8 * s; g.stroke();
        }
      } else { // speed lines
        g.strokeStyle = r.color; g.globalAlpha = 0.5; g.lineWidth = 1.5; g.lineCap = 'round';
        L = (8 + r.wpm * 0.35) * s;
        for (q = 0; q < 3; q++) { g.beginPath(); g.moveTo(x - 16 * s - L + q * 6, y - (14 + q * 11) * s); g.lineTo(x - 16 * s, y - (14 + q * 11) * s); g.stroke(); }
        g.globalAlpha = 1;
      }
      if (r.streak >= 25 && r.trail !== 'flames') { // a long clean streak adds a flame trail for everyone
        for (var m = 0; m < 4; m++) { g.fillStyle = m % 2 ? '#FFD27A' : '#FF8A5B'; g.globalAlpha = 0.7 - m * 0.15; g.beginPath(); g.arc(x - (18 + m * 9) * s, y - 12 * s + Math.sin(time * 18 + m) * 3 * s, (5 - m) * s, 0, TAU); g.fill(); }
        g.globalAlpha = 1;
      }
    }
    function drawBurst(g, b) {
      var k = b.t / 0.55, sc = (0.5 + 0.9 * Math.sin(Math.min(1, k * 1.4) * Math.PI / 2)) * b.s * 1.1, a = 1 - smooth((k - 0.6) / 0.4);
      g.save(); g.translate(b.x, b.y); g.globalAlpha = a; g.fillStyle = '#FFD27A'; g.beginPath();
      for (var i = 0; i < 16; i++) { var r = (i % 2 ? 8 : 17) * sc, an = TAU * i / 16 - Math.PI / 2; g.lineTo(Math.cos(an) * r, Math.sin(an) * r); }
      g.closePath(); g.fill();
      g.fillStyle = '#2A1B3D'; g.font = '700 ' + Math.round(10 * Math.max(0.95, sc)) + 'px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(b.word, 0, 1); g.restore();
    }
    function tag(g, r, x, y, s, used) {
      var txt = (r.me ? 'You' : (r.name || '').slice(0, 10)) + (r.bot ? ' · bot' : '') + (r.wpmT >= 1 ? ' · ' + Math.round(r.wpm) : '');
      g.font = '600 11px system-ui, -apple-system, Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      var w = g.measureText(txt).width + 12, ty = y - 56 * s - 12;
      for (var u = 0; u < used.length; u++) { var o = used[u]; if (Math.abs(o.x - x) < (o.w + w) / 2 + 2 && Math.abs(o.y - ty) < 20) return false; } // would cover another tag
      used.push({ x: x, y: ty, w: w });
      g.fillStyle = r.me ? ME : 'rgba(26,23,64,0.92)';
      g.beginPath(); if (g.roundRect) g.roundRect(x - w / 2, ty - 9, w, 18, 4); else g.rect(x - w / 2, ty - 9, w, 18); g.fill();
      g.fillStyle = r.me ? '#0B0F1E' : '#FFFFFF'; g.fillText(txt, x, ty + 0.5);
      return true;
    }

    function render() {
      var g = ctx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      g.drawImage(T.sky, 0, 0, W, groundTop);
      T.back(g, time);
      var fo = (scroll * 0.12) % W, no = (scroll * 0.32) % W;
      g.drawImage(T.far, -fo, 0); g.drawImage(T.far, W - fo, 0);
      g.drawImage(T.near, -no, 0); g.drawImage(T.near, W - no, 0);
      g.fillStyle = T.ground; g.fillRect(0, groundTop, W, H - groundTop);
      g.fillStyle = T.edge; g.fillRect(0, groundTop, W, 1);
      if (T.deco) T.deco(g);
      g.strokeStyle = T.lane; g.lineWidth = 1; g.setLineDash([12, 9]); g.lineDashOffset = scroll % 21;
      var l1 = groundTop + (H - groundTop) * 0.2, l2 = H - 3;
      g.beginPath(); g.moveTo(0, l1); g.lineTo(W, l1); g.moveTo(0, l2); g.lineTo(W, l2); g.stroke(); g.setLineDash([]);
      g.strokeStyle = 'rgba(232,236,255,0.35)'; g.beginPath(); g.moveTo(startX - 6, groundTop + 4); g.lineTo(startX - 6, H); g.stroke();
      // finish line: checkered strip and a flag
      var fh = H - groundTop, cs = Math.max(5, Math.round(fh / 14));
      for (var y = 0, k = 0; y < fh; y += cs, k++) { g.fillStyle = k % 2 ? '#FFFFFF' : '#1A1740'; g.fillRect(finishX + 4, groundTop + y, cs, Math.min(cs, fh - y)); g.fillStyle = k % 2 ? '#1A1740' : '#FFFFFF'; g.fillRect(finishX + 4 + cs, groundTop + y, cs, Math.min(cs, fh - y)); }
      g.strokeStyle = '#E8ECFF'; g.lineWidth = 2; g.beginPath(); g.moveTo(finishX + 4, groundTop); g.lineTo(finishX + 4, groundTop - H * 0.18); g.stroke();
      g.fillStyle = '#FFFFFF'; g.fillRect(finishX + 4, groundTop - H * 0.18, 22, 14); g.fillStyle = '#1A1740'; g.fillRect(finishX + 4, groundTop - H * 0.18, 11, 7); g.fillRect(finishX + 15, groundTop - H * 0.18 + 7, 11, 7);
      // runners, back to front
      var s = figureScale(), n = order.length, leader = null, firstDone = null, list = order.map(function (id) { return runners[id]; });
      list.forEach(function (r) { if (!leader || r.px > leader.px) leader = r; if (r.finished && r.finishMs != null && (!firstDone || r.finishMs < firstDone.finishMs)) firstDone = r; });
      var done = list.filter(function (r) { return r.finished; }).sort(function (a, b) { return (a.finishMs || 0) - (b.finishMs || 0); });
      list.sort(function (a, b) { return (a.laneY + a.dy) - (b.laneY + b.dy); });
      list.forEach(function (r, idx) {
        var x = runnerX(r) + r.dx + r.post * (24 * s + (Math.max(0, done.indexOf(r)) % 3) * 20 * s), y = r.laneY + r.dy, f = r.fight, kind = 'idle', facing = 1;
        var wpmF = clamp(r.wpm / 100, 0, 1.2), moving = data.running && !r.finished && r.wpm > 4;
        var color = r.rainbow ? 'hsl(' + ((time * 140 + idx * 40) % 360) + ',90%,66%)' : r.color;
        if (r.finished) kind = 'cheer';
        else if (f) { var phase1 = f.t < 0.46; kind = f.b === r ? (phase1 ? 'kick' : 'recoil') : (phase1 ? 'stumble' : 'punch'); if (f.a === r && !phase1) facing = -1; }
        else if (r.stumbleT > 0) kind = 'stumble';
        else if (moving) kind = 'run';
        g.fillStyle = r.me ? 'rgba(198,255,61,0.28)' : T.shadow; g.beginPath(); g.ellipse(x, y + 1, 12 * s, 3.4 * s, 0, 0, TAU); g.fill();
        if (moving && !f && wpmF > 0.2) { var sv = r.color; r.color = color; drawTrail(g, r, x, y, s); r.color = sv; }
        drawFigure(g, x, y, s, color, kind, r.phase, time, facing, wpmF, r.hat);
        if (firstDone === r) { g.fillStyle = '#FFD27A'; g.beginPath(); var cy = y - 56 * s - Math.abs(Math.sin(time * 9)) * 6 - (r.hat !== 'none' ? 8 * s : 0); g.moveTo(x - 6 * s, cy); g.lineTo(x - 6 * s, cy - 6 * s); g.lineTo(x - 3 * s, cy - 3 * s); g.lineTo(x, cy - 8 * s); g.lineTo(x + 3 * s, cy - 3 * s); g.lineTo(x + 6 * s, cy - 6 * s); g.lineTo(x + 6 * s, cy); g.closePath(); g.fill(); }
        r._x = x; r._y = y + (firstDone === r ? -6 : 0);
      });
      if (T.front) T.front(g);
      var used = [], byPriority = list.slice().sort(function (a, b) { // you, the leader and fighters first, then the rest from the front
        var pa = (a.me ? 0 : a === leader ? 1 : a.fight ? 2 : 3), pb = (b.me ? 0 : b === leader ? 1 : b.fight ? 2 : 3); return pa - pb || b.px - a.px;
      });
      bursts.forEach(function (b) { drawBurst(g, b); });
      byPriority.forEach(function (r) { if (n <= 6 || r.me || r === leader || r.fight || used.length < 5) tag(g, r, r._x, r._y, s, used); }); // name tags stay readable on top
    }

    // ---------- simulation ----------
    function update(dt) {
      time += dt;
      data = (opts.getData && opts.getData()) || data; sync();
      if (data.running) raceT += dt; else raceT = 0;
      var ref = data.refWpm || 0, target = data.running ? 45 + ref * 2.4 : 0;
      speed = lerp(speed, target, 1 - Math.exp(-dt * 2.5)); scroll += speed * dt;
      order.forEach(function (id) {
        var r = runners[id];
        r.px = lerp(r.px, r.target || 0, 1 - Math.exp(-dt * 7)); if (Math.abs(r.px - r.target) < 0.0004) r.px = r.target;
        r.wpm = lerp(r.wpm, data.running && !r.finished ? r.wpmT : 0, 1 - Math.exp(-dt * 4));
        r.phase += dt * TAU * (r.fight ? 0 : 1.1 + r.wpm / 40);
        r.post = lerp(r.post, r.finished ? 1 : 0, 1 - Math.exp(-dt * 3));
        r.stumbleT = Math.max(0, r.stumbleT - dt); r.cool = Math.max(0, r.cool - dt);
      });
      if (T.step) T.step(dt, speed);
      if (!data.running) overtake = {}; else detectOvertakes();
      updateFights(dt);
    }
    function frame(dt) { if (!T) resize(W, H, dpr); update(dt); render(); }
    function loop(ts) {
      if (!raf) return;
      var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016; last = ts;
      frame(dt); raf = requestAnimationFrame(loop);
    }

    return {
      supported: true, resize: resize, autosize: autosize, frame: frame, render: render, setWorld: setWorld,
      getWorld: function () { return world; },
      start: function () { if (raf) return; autosize(); last = 0; raf = requestAnimationFrame(loop); },
      stop: function () { if (raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf); raf = 0; },
      stumble: function (id) { if (runners[id]) runners[id].stumbleT = 0.4; },
      setStreak: function (id, n) { if (runners[id]) runners[id].streak = n; },
      summary: function () {
        var list = order.map(function (id) { return runners[id]; }).sort(function (a, b) { return b.px - a.px; });
        var me = list.filter(function (r) { return r.me; })[0]; if (!me) return 'Race scene with ' + list.length + ' runners.';
        var place = list.indexOf(me) + 1, mod = place % 100, ord = (mod >= 11 && mod <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][place % 10 < 4 ? place % 10 : 0];
        return 'You are in ' + place + ord + ' place of ' + list.length + '.';
      },
      _debug: function () { return { runners: runners, fights: fights, bursts: bursts, W: W, H: H }; }
    };
  }

  var api = { createScene: createScene, worldNames: WORLD_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TypeScene = api;
})(typeof window !== 'undefined' ? window : globalThis);
