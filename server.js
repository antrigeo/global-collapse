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

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const MAP_W = 2400, MAP_H = 1600;
const TICK_RATE = 30; // ms
const MAX_PLAYERS_PER_ROOM = 20;
const ZONE_SHRINK_INTERVAL = 25000;

const CHARS = {
  soldier: { hp: 120, spd: 3.2, dmg: 25, arm: 15 },
  medic:   { hp: 100, spd: 3.8, dmg: 15, arm: 5  },
  scout:   { hp: 80,  spd: 5.2, dmg: 20, arm: 0  },
};

const WEAPS = {
  fists:  { dmg: 8,  rng: 40,  fr: 800,  ammoUse: 0 },
  pistol: { dmg: 22, rng: 160, fr: 500,  ammoUse: 1 },
  smg:    { dmg: 18, rng: 200, fr: 120,  ammoUse: 1 },
  rifle:  { dmg: 42, rng: 300, fr: 400,  ammoUse: 1 },
  sniper: { dmg: 95, rng: 520, fr: 1500, ammoUse: 1 },
  shotgun:{ dmg: 55, rng: 110, fr: 800,  ammoUse: 2 },
};

const LOOT_TYPES = ['food','food','meds','ammo','ammo','pistol','smg','rifle','sniper','shotgun','armor'];

const VEHS_DEF = {
  car:   { spd: 7,  w: 40, h: 24 },
  boat:  { spd: 5,  w: 44, h: 22 },
  plane: { spd: 11, w: 48, h: 28 },
};

// ── ROOMS ──────────────────────────────────────────────────────────────────
// rooms: Map<roomId, RoomState>
const rooms = new Map();

function ri(a, b) { return Math.floor(Math.random() * (b - a)) + a; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function createLoot() {
  const items = [];
  for (let i = 0; i < 80; i++) {
    items.push({
      id: 'l' + i,
      x: ri(80, MAP_W - 80),
      y: ri(80, MAP_H - 80),
      type: LOOT_TYPES[ri(0, LOOT_TYPES.length)],
      picked: false
    });
  }
  return items;
}

function createVehicles() {
  const vehs = [];
  const types = Object.keys(VEHS_DEF);
  for (let i = 0; i < 10; i++) {
    vehs.push({
      id: 'v' + i,
      type: types[ri(0, types.length)],
      x: ri(150, MAP_W - 150),
      y: ri(150, MAP_H - 150),
      angle: 0,
      occupant: null,
      hp: 100
    });
  }
  return vehs;
}

function createNPCs() {
  const npcs = {};
  for (let i = 0; i < 25; i++) {
    npcs['n' + i] = {
      id: 'n' + i,
      x: ri(100, MAP_W - 100),
      y: ri(100, MAP_H - 100),
      hp: 50, maxHp: 50,
      spd: 1.4 + Math.random() * 0.6,
      dmg: 8,
      dir: Math.random() * Math.PI * 2,
      lastAtk: 0
    };
  }
  return npcs;
}

function createRoom(isPrivate = false, roomCode = null) {
  const id = roomCode || generateRoomId();
  const room = {
    id,
    isPrivate,
    players: {},      // socketId -> player state
    npcs: createNPCs(),
    loot: createLoot(),
    vehicles: createVehicles(),
    bullets: [],
    zone: { x: MAP_W / 2, y: MAP_H / 2, r: 900 },
    started: false,
    startTime: null,
    tickInterval: null,
    zoneInterval: null,
    bulletIdCounter: 0,
  };
  rooms.set(id, room);
  startRoomLoop(room);
  return room;
}

function startRoomLoop(room) {
  room.startTime = Date.now();
  room.started = true;

  // Zone shrink
  room.zoneInterval = setInterval(() => {
    if (!rooms.has(room.id)) { clearInterval(room.zoneInterval); return; }
    room.zone.r = Math.max(room.zone.r * 0.78, 80);
    room.zone.x = MAP_W / 2 + ri(-150, 150);
    room.zone.y = MAP_H / 2 + ri(-150, 150);
    io.to(room.id).emit('zone:update', room.zone);
  }, ZONE_SHRINK_INTERVAL);

  // Game tick
  room.tickInterval = setInterval(() => {
    if (!rooms.has(room.id)) { clearInterval(room.tickInterval); return; }
    tickRoom(room);
  }, TICK_RATE);
}

function tickRoom(room) {
  const now = Date.now();
  const alivePlayers = Object.values(room.players).filter(p => p.hp > 0);

  // Zone damage to players
  alivePlayers.forEach(p => {
    const d = dist(p, room.zone);
    if (d > room.zone.r) {
      p.hp = Math.max(0, p.hp - 0.15);
      if (p.hp <= 0) {
        p.hp = 0;
        io.to(p.socketId).emit('player:died', { reason: 'Eliminated by the zone' });
        broadcastKillfeed(room, p.name + ' died to the zone');
        checkWinner(room);
      }
    }
  });

  // Tick NPCs
  Object.values(room.npcs).forEach(n => {
    if (n.hp <= 0) return;
    // Zone damage
    if (dist(n, room.zone) > room.zone.r) {
      n.hp -= 0.5;
      if (n.hp <= 0) { delete room.npcs[n.id]; return; }
    }
    // Chase nearest player
    let nearest = null, nearDist = 9999;
    alivePlayers.forEach(p => {
      const d = dist(n, p);
      if (d < nearDist) { nearDist = d; nearest = p; }
    });
    if (nearest && nearDist < 300) {
      n.dir = Math.atan2(nearest.y - n.y, nearest.x - n.x);
    } else {
      n.dir += (Math.random() - 0.5) * 0.25;
    }
    n.x = clamp(n.x + Math.cos(n.dir) * n.spd * 0.5, 10, MAP_W - 10);
    n.y = clamp(n.y + Math.sin(n.dir) * n.spd * 0.5, 10, MAP_H - 10);
    // Attack
    if (nearest && nearDist < 40 && now - n.lastAtk > 1000) {
      n.lastAtk = now;
      const dmg = Math.max(1, n.dmg - (nearest.armor || 0));
      nearest.hp = Math.max(0, nearest.hp - dmg);
      io.to(nearest.socketId).emit('player:hit', { dmg, from: 'npc' });
      if (nearest.hp <= 0) {
        io.to(nearest.socketId).emit('player:died', { reason: 'Killed by infected NPC' });
        broadcastKillfeed(room, nearest.name + ' was killed by an NPC');
        checkWinner(room);
      }
    }
  });

  // Tick bullets
  room.bullets = room.bullets.filter(b => {
    b.x += Math.cos(b.angle) * 14;
    b.y += Math.sin(b.angle) * 14;
    b._dist += 14;
    if (b._dist > (b.maxRange || 200)) return false;
    if (b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) return false;

    // Hit NPCs
    for (const n of Object.values(room.npcs)) {
      if (n.hp <= 0) continue;
      if (dist(b, n) < 16) {
        n.hp -= b.dmg;
        const shooter = room.players[b.ownerId];
        if (n.hp <= 0) {
          delete room.npcs[n.id];
          if (shooter) {
            shooter.score += 10;
            shooter.coins += 5;
            io.to(shooter.socketId).emit('player:scoreup', { score: shooter.score, coins: shooter.coins, reason: '+10 NPC kill' });
          }
        }
        return false;
      }
    }

    // Hit players
    for (const p of alivePlayers) {
      if (p.socketId === b.ownerId) continue;
      if (dist(b, p) < 18) {
        const dmg = Math.max(1, b.dmg - (p.armor || 0));
        p.hp = Math.max(0, p.hp - dmg);
        io.to(p.socketId).emit('player:hit', { dmg, from: b.ownerName });
        const shooter = room.players[b.ownerId];
        if (p.hp <= 0) {
          io.to(p.socketId).emit('player:died', { reason: 'Eliminated by ' + b.ownerName });
          broadcastKillfeed(room, b.ownerName + ' eliminated ' + p.name);
          if (shooter) {
            shooter.kills++;
            shooter.score += 50;
            shooter.coins += 25;
            io.to(shooter.socketId).emit('player:scoreup', {
              score: shooter.score, coins: shooter.coins,
              kills: shooter.kills, reason: '+50 player kill!'
            });
          }
          checkWinner(room);
        }
        return false;
      }
    }
    return true;
  });

  // Broadcast game state (delta)
  const statePayload = {
    players: {},
    npcs: {},
    bullets: room.bullets.map(b => ({ x: b.x, y: b.y, angle: b.angle, col: b.col })),
    zone: room.zone,
  };
  alivePlayers.forEach(p => {
    statePayload.players[p.socketId] = {
      x: p.x, y: p.y, angle: p.angle, hp: p.hp, maxHp: p.maxHp,
      armor: p.armor, char: p.char, name: p.name, score: p.score,
      weapon: p.weapon, inVehicle: p.inVehicle
    };
  });
  Object.values(room.npcs).forEach(n => {
    if (n.hp > 0) statePayload.npcs[n.id] = { x: n.x, y: n.y, hp: n.hp, maxHp: n.maxHp };
  });
  io.to(room.id).emit('game:state', statePayload);
}

function broadcastKillfeed(room, msg) {
  io.to(room.id).emit('killfeed', msg);
}

function checkWinner(room) {
  const alive = Object.values(room.players).filter(p => p.hp > 0);
  if (alive.length === 1) {
    io.to(alive[0].socketId).emit('player:won', { reason: 'Last survivor standing!' });
    io.to(room.id).emit('killfeed', alive[0].name + ' WINS!');
    setTimeout(() => destroyRoom(room.id), 10000);
  } else if (alive.length === 0) {
    destroyRoom(room.id);
  }
}

function destroyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearInterval(room.tickInterval);
  clearInterval(room.zoneInterval);
  rooms.delete(roomId);
}

// ── MATCHMAKING QUEUE ──────────────────────────────────────────────────────
let publicQueue = []; // [{socket, playerData}]
let publicRoom = null; // current filling public room

function findOrCreatePublicRoom() {
  // Find a public room with space
  for (const [id, room] of rooms) {
    if (!room.isPrivate && Object.keys(room.players).length < MAX_PLAYERS_PER_ROOM) {
      return room;
    }
  }
  return createRoom(false);
}

// ── SOCKET HANDLERS ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // ── JOIN PUBLIC MATCH ──
  socket.on('match:join', (data) => {
    // data: { name, char, city }
    const room = findOrCreatePublicRoom();
    joinRoom(socket, room, data);
  });

  // ── CREATE PRIVATE ROOM ──
  socket.on('room:create', (data) => {
    // data: { name, char, city, code? }
    const code = data.code || generateRoomId();
    let room = rooms.get(code);
    if (!room) room = createRoom(true, code);
    socket.emit('room:created', { code: room.id });
    joinRoom(socket, room, data);
  });

  // ── JOIN PRIVATE ROOM ──
  socket.on('room:join', (data) => {
    // data: { name, char, city, code }
    const room = rooms.get(data.code?.toUpperCase());
    if (!room) {
      socket.emit('room:error', { msg: 'Room not found! Check the code.' });
      return;
    }
    if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('room:error', { msg: 'Room is full!' });
      return;
    }
    joinRoom(socket, room, data);
  });

  // ── PLAYER MOVE ──
  socket.on('player:move', (data) => {
    // data: { x, y, angle, inVehicle }
    const player = findPlayer(socket.id);
    if (!player) return;
    player.x = clamp(data.x, 10, MAP_W - 10);
    player.y = clamp(data.y, 10, MAP_H - 10);
    player.angle = data.angle || 0;
    player.inVehicle = data.inVehicle || null;
  });

  // ── PLAYER SHOOT ──
  socket.on('player:shoot', (data) => {
    // data: { angle }
    const result = findPlayerAndRoom(socket.id);
    if (!result) return;
    const { player, room } = result;
    if (player.hp <= 0) return;
    const w = WEAPS[player.weapon] || WEAPS.pistol;
    if (player.ammo <= 0 && player.weapon !== 'fists') return;
    const now = Date.now();
    if (now - (player._lastShot || 0) < w.fr) return;
    player._lastShot = now;
    if (w.ammoUse) player.ammo = Math.max(0, player.ammo - w.ammoUse);
    room.bulletIdCounter++;
    room.bullets.push({
      id: 'b' + room.bulletIdCounter,
      x: player.x, y: player.y,
      angle: data.angle,
      dmg: w.dmg,
      maxRange: w.rng,
      col: getWeaponColor(player.weapon),
      ownerId: socket.id,
      ownerName: player.name,
      _dist: 0
    });
    socket.emit('ammo:update', { ammo: player.ammo });
  });

  // ── PICKUP ──
  socket.on('player:pickup', (data) => {
    const result = findPlayerAndRoom(socket.id);
    if (!result) return;
    const { player, room } = result;

    // Vehicle enter
    const nearVeh = room.vehicles.find(v => !v.occupant && dist(player, v) < 60);
    if (nearVeh) {
      nearVeh.occupant = socket.id;
      player.inVehicle = nearVeh.id;
      socket.emit('vehicle:entered', { vehicleId: nearVeh.id, type: nearVeh.type });
      io.to(room.id).emit('vehicle:update', { id: nearVeh.id, occupant: socket.id });
      return;
    }

    // Loot
    const nearLoot = room.loot.find(l => !l.picked && dist(player, l) < 50);
    if (!nearLoot) return;

    const WEAP_UNLOCK = { pistol: 0, smg: 50, rifle: 100, sniper: 200, shotgun: 80 };
    const wType = nearLoot.type;

    if (['pistol','smg','rifle','sniper','shotgun'].includes(wType)) {
      const needed = WEAP_UNLOCK[wType] || 0;
      if (player.score >= needed) {
        nearLoot.picked = true;
        player.weapon = wType;
        player.ammo += 30;
        socket.emit('loot:picked', { type: wType, msg: 'Got ' + wType.toUpperCase() + '!' });
      } else {
        socket.emit('loot:fail', { msg: 'Need ' + needed + ' score for ' + wType });
      }
    } else if (wType === 'food') {
      nearLoot.picked = true;
      player.food = (player.food || 0) + 1;
      socket.emit('loot:picked', { type: 'food', msg: 'Found food 🍖' });
    } else if (wType === 'meds') {
      nearLoot.picked = true;
      player.meds = (player.meds || 0) + 1;
      socket.emit('loot:picked', { type: 'meds', msg: 'Found medkit 💊' });
    } else if (wType === 'ammo') {
      nearLoot.picked = true;
      player.ammo += 20;
      socket.emit('loot:picked', { type: 'ammo', msg: '+20 ammo 📦' });
    } else if (wType === 'armor') {
      nearLoot.picked = true;
      player.armor = Math.min(30, (player.armor || 0) + 10);
      socket.emit('loot:picked', { type: 'armor', msg: 'Armor +10 🛡' });
    }
    io.to(room.id).emit('loot:update', { id: nearLoot.id, picked: true });
  });

  // ── EXIT VEHICLE ──
  socket.on('vehicle:exit', () => {
    const result = findPlayerAndRoom(socket.id);
    if (!result) return;
    const { player, room } = result;
    if (!player.inVehicle) return;
    const v = room.vehicles.find(vv => vv.id === player.inVehicle);
    if (v) v.occupant = null;
    player.inVehicle = null;
    socket.emit('vehicle:exited');
    io.to(room.id).emit('vehicle:update', { id: v?.id, occupant: null });
  });

  // ── USE ITEM ──
  socket.on('player:useitem', () => {
    const player = findPlayer(socket.id);
    if (!player) return;
    if (player.meds > 0) {
      player.meds--;
      player.hp = Math.min(player.maxHp, player.hp + 40);
      socket.emit('item:used', { msg: 'Medkit +40 HP 💊', hp: player.hp });
    } else if (player.food > 0) {
      player.food--;
      player.hp = Math.min(player.maxHp, player.hp + 15);
      socket.emit('item:used', { msg: 'Food +15 HP 🍖', hp: player.hp });
    } else {
      socket.emit('item:used', { msg: 'No items!' });
    }
  });

  // ── SHOP: BUY WEAPON ──
  socket.on('shop:buy:weapon', (data) => {
    // data: { weapon }
    const player = findPlayer(socket.id);
    if (!player) return;
    const SHOP_WEAPONS = {
      smg:    { cost: 100, minScore: 30 },
      rifle:  { cost: 200, minScore: 80 },
      sniper: { cost: 350, minScore: 150 },
      shotgun:{ cost: 150, minScore: 50 },
    };
    const item = SHOP_WEAPONS[data.weapon];
    if (!item) return;
    if (player.coins < item.cost) { socket.emit('shop:fail', { msg: 'Not enough coins!' }); return; }
    if (player.score < item.minScore) { socket.emit('shop:fail', { msg: 'Need more score!' }); return; }
    player.coins -= item.cost;
    player.weapon = data.weapon;
    player.ammo += 40;
    socket.emit('shop:bought', { weapon: data.weapon, coins: player.coins, ammo: player.ammo });
  });

  // ── SHOP: BUY VEHICLE ──
  socket.on('shop:buy:vehicle', (data) => {
    const result = findPlayerAndRoom(socket.id);
    if (!result) return;
    const { player, room } = result;
    const SHOP_VEHICLES = { car: 80, boat: 120, plane: 250 };
    const cost = SHOP_VEHICLES[data.type];
    if (!cost) return;
    if (player.coins < cost) { socket.emit('shop:fail', { msg: 'Not enough coins!' }); return; }
    player.coins -= cost;
    // Spawn vehicle near player
    const newVeh = {
      id: 'sv' + Date.now(),
      type: data.type,
      x: player.x + ri(60, 100),
      y: player.y + ri(-40, 40),
      angle: 0,
      occupant: null,
      hp: 100
    };
    room.vehicles.push(newVeh);
    socket.emit('shop:vehicle:spawned', { vehicle: newVeh, coins: player.coins });
    io.to(room.id).emit('vehicle:spawned', newVeh);
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const result = findPlayerAndRoom(socket.id);
    if (result) {
      const { player, room } = result;
      broadcastKillfeed(room, player.name + ' left the game');
      // Free vehicle
      room.vehicles.forEach(v => { if (v.occupant === socket.id) v.occupant = null; });
      delete room.players[socket.id];
      io.to(room.id).emit('player:left', { id: socket.id });
      // Destroy empty rooms
      if (Object.keys(room.players).length === 0) {
        setTimeout(() => {
          if (rooms.has(room.id) && Object.keys(room.players).length === 0) {
            destroyRoom(room.id);
          }
        }, 30000);
      }
      checkWinner(room);
    }
    console.log('Disconnected:', socket.id);
  });
});

// ── HELPERS ────────────────────────────────────────────────────────────────
function joinRoom(socket, room, data) {
  const cd = CHARS[data.char] || CHARS.soldier;
  const player = {
    socketId: socket.id,
    name: data.name || 'SURVIVOR',
    char: data.char || 'soldier',
    city: data.city || 'UNKNOWN',
    x: ri(400, MAP_W - 400),
    y: ri(400, MAP_H - 400),
    hp: cd.hp, maxHp: cd.hp,
    armor: cd.arm,
    score: 0,
    kills: 0,
    coins: 50, // start coins
    weapon: 'pistol',
    ammo: 20,
    food: 2,
    meds: 1,
    angle: 0,
    inVehicle: null,
    _lastShot: 0,
  };
  room.players[socket.id] = player;
  socket.join(room.id);

  // Send initial state
  socket.emit('game:joined', {
    playerId: socket.id,
    roomId: room.id,
    isPrivate: room.isPrivate,
    loot: room.loot,
    vehicles: room.vehicles,
    zone: room.zone,
    playerCount: Object.keys(room.players).length,
    myState: player,
  });

  // Notify others
  socket.to(room.id).emit('player:joined', {
    id: socket.id,
    name: player.name,
    char: player.char,
    x: player.x, y: player.y,
  });

  broadcastKillfeed(room, player.name + ' dropped into ' + player.city);
  console.log(`${player.name} joined room ${room.id} (${Object.keys(room.players).length} players)`);
}

function findPlayer(socketId) {
  for (const room of rooms.values()) {
    if (room.players[socketId]) return room.players[socketId];
  }
  return null;
}

function findPlayerAndRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.players[socketId]) return { player: room.players[socketId], room };
  }
  return null;
}

function getWeaponColor(weapon) {
  const cols = { fists:'#888', pistol:'#facc15', smg:'#fb923c', rifle:'#f87171', sniper:'#c084fc', shotgun:'#34d399' };
  return cols[weapon] || '#facc15';
}

// ── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Global Collapse server running on port ${PORT}`);
});
