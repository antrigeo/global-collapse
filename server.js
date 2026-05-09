const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game Constants ───────────────────────────────────────────────────────────
const MAP_W = 2400;
const MAP_H = 1600;
const TICK_MS = 50; // 20 ticks/sec
const MAX_ROOM_PLAYERS = 6;
const LOOT_COUNT = 60;
const NPC_COUNT = 20;
const ZONE_SHRINK_INTERVAL = 30000; // 30s

// ─── Data ─────────────────────────────────────────────────────────────────────
const CHARACTERS = {
  soldier: { name: 'Soldier', hp: 120, speed: 3.2, damage: 25, armor: 15, color: '#4ade80', icon: '🪖' },
  medic:   { name: 'Medic',   hp: 100, speed: 3.5, damage: 15, armor: 5,  color: '#60a5fa', icon: '⚕️' },
  scout:   { name: 'Scout',   hp: 80,  speed: 5.0, damage: 20, armor: 0,  color: '#f59e0b', icon: '👁' },
};

const WEAPONS = {
  fists:   { name: 'Fists',      damage: 8,  range: 40,  ammo: Infinity, fireRate: 800,  color: '#888',    unlockScore: 0   },
  pistol:  { name: 'Pistol',     damage: 22, range: 150, ammo: 30,       fireRate: 500,  color: '#facc15', unlockScore: 0   },
  smg:     { name: 'SMG',        damage: 18, range: 180, ammo: 60,       fireRate: 150,  color: '#fb923c', unlockScore: 50  },
  rifle:   { name: 'Rifle',      damage: 40, range: 280, ammo: 30,       fireRate: 400,  color: '#f87171', unlockScore: 100 },
  sniper:  { name: 'Sniper',     damage: 90, range: 500, ammo: 10,       fireRate: 1500, color: '#c084fc', unlockScore: 200 },
  shotgun: { name: 'Shotgun',    damage: 55, range: 100, ammo: 20,       fireRate: 800,  color: '#34d399', unlockScore: 80  },
};

// ─── State ────────────────────────────────────────────────────────────────────
const rooms = {};      // roomId -> room object
const lobby = [];      // socket ids waiting for match
const playerRoom = {}; // socketId -> roomId

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2, 9); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min)) + min; }

function spawnLoot() {
  const types = ['food', 'meds', 'ammo', 'pistol', 'smg', 'rifle', 'sniper', 'shotgun', 'armor'];
  return Array.from({ length: LOOT_COUNT }, () => ({
    id: uid(),
    x: randInt(80, MAP_W - 80),
    y: randInt(80, MAP_H - 80),
    type: types[randInt(0, types.length)],
    picked: false,
  }));
}

function spawnNPCs() {
  return Array.from({ length: NPC_COUNT }, () => ({
    id: uid(),
    x: randInt(100, MAP_W - 100),
    y: randInt(100, MAP_H - 100),
    hp: 50,
    maxHp: 50,
    speed: 1.2 + Math.random() * 0.8,
    damage: 8,
    color: '#ff4444',
    target: null,
    dir: Math.random() * Math.PI * 2,
    lastAttack: 0,
    state: 'wander', // wander | chase | attack
  }));
}

function createRoom(id) {
  return {
    id,
    players: {},
    loot: spawnLoot(),
    npcs: spawnNPCs(),
    bullets: [],
    zone: { x: MAP_W / 2, y: MAP_H / 2, r: Math.min(MAP_W, MAP_H) * 0.55 },
    targetZone: { x: MAP_W / 2, y: MAP_H / 2, r: 300 },
    zoneShrinking: false,
    tick: 0,
    started: false,
    gameOver: false,
    startTime: Date.now(),
    interval: null,
    shrinkInterval: null,
  };
}

function startRoom(room) {
  if (room.started) return;
  room.started = true;
  room.startTime = Date.now();

  // Broadcast game start
  io.to(room.id).emit('game:start', {
    loot: room.loot,
    npcs: room.npcs.map(n => ({ ...n })),
    zone: room.zone,
    mapW: MAP_W,
    mapH: MAP_H,
  });

  // Zone shrink
  room.shrinkInterval = setInterval(() => {
    if (room.gameOver) return;
    room.zoneShrinking = true;
    room.targetZone.r = Math.max(room.targetZone.r * 0.7, 120);
    room.targetZone.x = MAP_W / 2 + randInt(-80, 80);
    room.targetZone.y = MAP_H / 2 + randInt(-80, 80);
    io.to(room.id).emit('zone:update', { zone: room.zone, target: room.targetZone });
  }, ZONE_SHRINK_INTERVAL);

  // Game tick
  room.interval = setInterval(() => gameTick(room), TICK_MS);
}

function gameTick(room) {
  if (room.gameOver) return;
  room.tick++;

  // Shrink zone gradually
  if (room.zoneShrinking) {
    const t = room.targetZone;
    room.zone.r += (t.r - room.zone.r) * 0.01;
    room.zone.x += (t.x - room.zone.x) * 0.01;
    room.zone.y += (t.y - room.zone.y) * 0.01;
  }

  const now = Date.now();
  const alivePlayers = Object.values(room.players).filter(p => p.hp > 0);

  // ── NPC AI ──
  room.npcs.forEach(npc => {
    if (npc.hp <= 0) return;

    // Find nearest player
    let nearest = null, nearestDist = Infinity;
    alivePlayers.forEach(p => {
      const d = dist(npc, p);
      if (d < nearestDist) { nearestDist = d; nearest = p; }
    });

    if (nearest && nearestDist < 300) {
      npc.state = nearestDist < 45 ? 'attack' : 'chase';
      npc.target = nearest.id;
    } else {
      npc.state = 'wander';
      npc.target = null;
    }

    if (npc.state === 'chase' && nearest) {
      const angle = Math.atan2(nearest.y - npc.y, nearest.x - npc.x);
      npc.x += Math.cos(angle) * npc.speed;
      npc.y += Math.sin(angle) * npc.speed;
    } else if (npc.state === 'wander') {
      npc.dir += (Math.random() - 0.5) * 0.15;
      npc.x += Math.cos(npc.dir) * npc.speed * 0.5;
      npc.y += Math.sin(npc.dir) * npc.speed * 0.5;
    } else if (npc.state === 'attack' && nearest && now - npc.lastAttack > 1000) {
      npc.lastAttack = now;
      nearest.hp -= npc.damage;
      io.to(room.id).emit('player:hit', { id: nearest.id, hp: nearest.hp, dmg: npc.damage, by: 'npc' });
      if (nearest.hp <= 0) handlePlayerDeath(room, nearest, 'npc');
    }

    npc.x = clamp(npc.x, 10, MAP_W - 10);
    npc.y = clamp(npc.y, 10, MAP_H - 10);
  });

  // ── Zone damage ──
  if (room.tick % 20 === 0) {
    alivePlayers.forEach(p => {
      const d = dist(p, room.zone);
      if (d > room.zone.r) {
        const dmg = Math.floor((d - room.zone.r) / 40) + 2;
        p.hp = Math.max(0, p.hp - dmg);
        io.to(p.socketId).emit('player:hit', { id: p.id, hp: p.hp, dmg, by: 'zone' });
        if (p.hp <= 0) handlePlayerDeath(room, p, 'zone');
      }
    });
  }

  // ── Bullet movement ──
  room.bullets = room.bullets.filter(b => {
    b.x += Math.cos(b.angle) * b.speed;
    b.y += Math.sin(b.angle) * b.speed;
    b.dist += b.speed;
    if (b.dist > b.maxDist) return false;

    // Hit NPCs
    for (const npc of room.npcs) {
      if (npc.hp <= 0) continue;
      if (dist(b, npc) < 18) {
        npc.hp -= b.damage;
        io.to(room.id).emit('npc:hit', { id: npc.id, hp: npc.hp, x: npc.x, y: npc.y });
        if (npc.hp <= 0) {
          io.to(room.id).emit('npc:dead', { id: npc.id });
          // Give score to shooter
          const shooter = room.players[b.shooterId];
          if (shooter) {
            shooter.score += 10;
            io.to(shooter.socketId).emit('score:update', { score: shooter.score });
          }
        }
        return false;
      }
    }

    // Hit players
    for (const p of alivePlayers) {
      if (p.id === b.shooterId) continue;
      if (dist(b, p) < 20) {
        const dmg = Math.max(1, b.damage - (p.armor || 0));
        p.hp = Math.max(0, p.hp - dmg);
        io.to(room.id).emit('player:hit', { id: p.id, hp: p.hp, dmg, by: b.shooterId });
        if (p.hp <= 0) handlePlayerDeath(room, p, b.shooterId);
        return false;
      }
    }
    return true;
  });

  // ── Broadcast state ──
  if (room.tick % 2 === 0) {
    io.to(room.id).emit('state:update', {
      players: alivePlayers.map(p => ({ id: p.id, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, name: p.name, char: p.char, weapon: p.weapon, score: p.score, angle: p.angle || 0 })),
      npcs: room.npcs.filter(n => n.hp > 0).map(n => ({ id: n.id, x: n.x, y: n.y, hp: n.hp, state: n.state })),
      bullets: room.bullets.map(b => ({ id: b.id, x: b.x, y: b.y, color: b.color })),
      zone: { x: room.zone.x, y: room.zone.y, r: room.zone.r },
    });
  }

  // ── Check win ──
  const stillAlive = Object.values(room.players).filter(p => p.hp > 0);
  if (room.started && stillAlive.length <= 1 && Object.keys(room.players).length > 1) {
    room.gameOver = true;
    const winner = stillAlive[0];
    io.to(room.id).emit('game:over', { winner: winner ? { id: winner.id, name: winner.name, score: winner.score } : null });
    clearInterval(room.interval);
    clearInterval(room.shrinkInterval);
    setTimeout(() => cleanRoom(room.id), 30000);
  }
}

function handlePlayerDeath(room, player, killedBy) {
  player.hp = 0;
  io.to(room.id).emit('player:dead', { id: player.id, killedBy });
  if (typeof killedBy === 'string' && room.players[killedBy]) {
    room.players[killedBy].score += 50;
    io.to(room.players[killedBy].socketId).emit('score:update', { score: room.players[killedBy].score });
  }
}

function cleanRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  clearInterval(room.interval);
  clearInterval(room.shrinkInterval);
  Object.keys(room.players).forEach(pid => { delete playerRoom[pid]; });
  delete rooms[roomId];
}

function addAIPlayers(room, count) {
  const charKeys = Object.keys(CHARACTERS);
  const names = ['RAMIREZ', 'CHEN', 'KOZLOV', 'OMAR', 'SILVA', 'TANAKA'];
  for (let i = 0; i < count; i++) {
    const charKey = charKeys[randInt(0, charKeys.length)];
    const char = CHARACTERS[charKey];
    const id = 'ai_' + uid();
    room.players[id] = {
      id, socketId: null, isAI: true,
      name: names[i % names.length],
      char: charKey,
      x: randInt(200, MAP_W - 200), y: randInt(200, MAP_H - 200),
      hp: char.hp, maxHp: char.hp,
      speed: char.speed, damage: char.damage, armor: char.armor,
      weapon: 'pistol', inventory: { food: 2, meds: 1, ammo: 30 },
      score: 0, angle: 0,
    };
  }
}

// ─── Socket Events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connect:', socket.id);

  // ── Matchmaking ──
  socket.on('lobby:join', ({ name, char }) => {
    const charData = CHARACTERS[char] || CHARACTERS.soldier;

    // Check existing rooms with space
    let targetRoom = null;
    for (const r of Object.values(rooms)) {
      if (!r.started && !r.gameOver && Object.keys(r.players).length < MAX_ROOM_PLAYERS) {
        targetRoom = r; break;
      }
    }
    if (!targetRoom) {
      const rid = uid();
      rooms[rid] = createRoom(rid);
      targetRoom = rooms[rid];
    }

    const room = targetRoom;
    const player = {
      id: socket.id,
      socketId: socket.id,
      isAI: false,
      name: (name || 'SURVIVOR').toUpperCase().slice(0, 12),
      char,
      x: randInt(200, MAP_W - 200), y: randInt(200, MAP_H - 200),
      hp: charData.hp, maxHp: charData.hp,
      speed: charData.speed, damage: charData.damage, armor: charData.armor,
      weapon: 'pistol',
      inventory: { food: 0, meds: 0, ammo: 15 },
      score: 0, angle: 0,
      lastShot: 0,
    };

    room.players[socket.id] = player;
    playerRoom[socket.id] = room.id;
    socket.join(room.id);

    socket.emit('lobby:joined', {
      playerId: socket.id,
      roomId: room.id,
      playerCount: Object.keys(room.players).length,
      spawnX: player.x,
      spawnY: player.y,
      mapW: MAP_W,
      mapH: MAP_H,
    });

    io.to(room.id).emit('lobby:playercount', { count: Object.keys(room.players).length });

    // Auto-start: 2+ real players OR after 8s solo
    const realPlayers = Object.values(room.players).filter(p => !p.isAI).length;
    if (realPlayers >= 2) {
      if (!room._startTimer) {
        room._startTimer = setTimeout(() => {
          const needed = MAX_ROOM_PLAYERS - Object.keys(room.players).length;
          if (needed > 0) addAIPlayers(room, Math.min(needed, 3));
          startRoom(room);
        }, 3000);
      }
    } else {
      // Solo: wait 8s then fill with AI
      if (!room._soloTimer) {
        room._soloTimer = setTimeout(() => {
          if (!room.started) {
            const needed = MAX_ROOM_PLAYERS - Object.keys(room.players).length;
            addAIPlayers(room, Math.min(needed, 5));
            startRoom(room);
          }
        }, 8000);
      }
    }
  });

  // ── Player movement ──
  socket.on('player:move', ({ x, y, angle }) => {
    const rid = playerRoom[socket.id];
    if (!rid || !rooms[rid]) return;
    const room = rooms[rid];
    const p = room.players[socket.id];
    if (!p || p.hp <= 0) return;
    p.x = clamp(x, 0, MAP_W);
    p.y = clamp(y, 0, MAP_H);
    p.angle = angle;
  });

  // ── Shoot ──
  socket.on('player:shoot', ({ angle }) => {
    const rid = playerRoom[socket.id];
    if (!rid || !rooms[rid]) return;
    const room = rooms[rid];
    const p = room.players[socket.id];
    if (!p || p.hp <= 0) return;
    const wep = WEAPONS[p.weapon] || WEAPONS.pistol;
    const now = Date.now();
    if (now - p.lastShot < wep.fireRate) return;
    if (p.inventory.ammo <= 0 && p.weapon !== 'fists') return;
    p.lastShot = now;
    if (p.weapon !== 'fists') p.inventory.ammo = Math.max(0, p.inventory.ammo - 1);

    const bullet = {
      id: uid(),
      shooterId: socket.id,
      x: p.x, y: p.y,
      angle, speed: 14,
      damage: wep.damage + p.damage * 0.3,
      maxDist: wep.range,
      dist: 0,
      color: wep.color,
    };
    room.bullets.push(bullet);
    socket.to(room.id).emit('bullet:fired', { x: p.x, y: p.y, angle, color: wep.color });
  });

  // ── Pick up loot ──
  socket.on('loot:pickup', ({ lootId }) => {
    const rid = playerRoom[socket.id];
    if (!rid || !rooms[rid]) return;
    const room = rooms[rid];
    const loot = room.loot.find(l => l.id === lootId && !l.picked);
    if (!loot) return;
    const p = room.players[socket.id];
    if (!p || dist(p, loot) > 50) return;
    loot.picked = true;

    const wepTypes = ['pistol', 'smg', 'rifle', 'sniper', 'shotgun'];
    if (wepTypes.includes(loot.type)) {
      const wep = WEAPONS[loot.type];
      if (p.score >= wep.unlockScore) {
        p.weapon = loot.type;
        p.inventory.ammo = (p.inventory.ammo || 0) + wep.ammo;
        socket.emit('loot:got', { type: loot.type, msg: `Picked up ${wep.name}!` });
      } else {
        socket.emit('loot:got', { type: 'locked', msg: `Need ${wep.unlockScore} score to unlock ${wep.name}` });
        return;
      }
    } else if (loot.type === 'food') {
      p.inventory.food = (p.inventory.food || 0) + 1;
      socket.emit('loot:got', { type: 'food', msg: 'Found food (+1)' });
    } else if (loot.type === 'meds') {
      p.hp = Math.min(p.maxHp, p.hp + 30);
      socket.emit('loot:got', { type: 'meds', msg: 'Used medkit! +30 HP', hp: p.hp });
    } else if (loot.type === 'ammo') {
      p.inventory.ammo = (p.inventory.ammo || 0) + 20;
      socket.emit('loot:got', { type: 'ammo', msg: 'Found ammo (+20)' });
    } else if (loot.type === 'armor') {
      p.armor = Math.min(30, (p.armor || 0) + 10);
      socket.emit('loot:got', { type: 'armor', msg: 'Found armor (+10)' });
    }

    io.to(room.id).emit('loot:remove', { id: lootId });
  });

  // ── Use item ──
  socket.on('item:use', ({ type }) => {
    const rid = playerRoom[socket.id];
    if (!rid || !rooms[rid]) return;
    const p = rooms[rid].players[socket.id];
    if (!p) return;
    if (type === 'food' && p.inventory.food > 0) {
      p.inventory.food--;
      p.hp = Math.min(p.maxHp, p.hp + 15);
      socket.emit('item:used', { type: 'food', hp: p.hp, msg: 'Ate food. +15 HP' });
    } else if (type === 'meds' && p.inventory.meds > 0) {
      p.inventory.meds--;
      p.hp = Math.min(p.maxHp, p.hp + 40);
      socket.emit('item:used', { type: 'meds', hp: p.hp, msg: 'Used medkit. +40 HP' });
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const rid = playerRoom[socket.id];
    if (rid && rooms[rid]) {
      const room = rooms[rid];
      delete room.players[socket.id];
      delete playerRoom[socket.id];
      io.to(rid).emit('player:left', { id: socket.id });
      if (Object.values(room.players).filter(p => !p.isAI).length === 0) {
        setTimeout(() => cleanRoom(rid), 5000);
      }
    }
    console.log('Disconnect:', socket.id);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Global Collapse server running on port ${PORT}`));
