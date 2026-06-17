const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Decimal = require('decimal.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const SUITS = ['♠', '♣', '♥', '♦'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function isRed(suit) { return suit === '♥' || suit === '♦'; }
function cardVal(rank) {
  if (rank === 'A') return 1;
  if (rank === 'J') return 11;
  if (rank === 'Q') return 12;
  if (rank === 'K') return 13;
  return parseInt(rank);
}
function D(x) { return new Decimal(x); }

function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, red: isRed(s) });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

const AUCTION_SECONDS = 13;
const POSITION_SECONDS = 40;

function initRoom(roomId) {
  rooms[roomId] = {
    id: roomId,
    phase: 'lobby',
    // players: { pid, name, socketId }
    // pid is a stable UUID chosen by the client, NOT socket.id
    players: [],
    host: null,
    deck: [],
    hands: {},
    community: [],
    marketMaker: null,
    spread: 0,
    auction: { currentBid: null, currentLeader: null, timerEnd: null, timerHandle: null },
    instances: [
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
    ],
    currentInstance: 0,
    leaderboard: {},
    roundPnl: {},
    txLog: [],
    txLogPending: [],
  };
  return rooms[roomId];
}

function getRoom(roomId) { return rooms[roomId]; }

function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  for (const player of room.players) {
    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket) continue;
    socket.emit('state', buildClientState(room, player.pid));
  }
}

function buildClientState(room, pid) {
  const hands = {};
  for (const p of room.players) {
    if (p.pid === pid || room.phase === 'results') {
      hands[p.pid] = room.hands[p.pid] || [];
    } else {
      hands[p.pid] = (room.hands[p.pid] || []).map(() => null);
    }
  }

  let visibleCommunity = [];
  if (room.phase === 'market') {
    const fc = [0, 3, 5][room.currentInstance];
    visibleCommunity = room.community.map((c, i) => i < fc ? c : null);
  } else if (room.phase === 'results') {
    visibleCommunity = room.community;
  } else {
    visibleCommunity = room.community.map(() => null);
  }

  return {
    roomId: room.id,
    phase: room.phase,
    players: room.players.map(p => ({ id: p.pid, name: p.name, connected: p.connected !== false })),
    host: room.host,
    myId: pid,
    hands,
    community: visibleCommunity,
    marketMaker: room.marketMaker,
    spread: room.spread,
    auction: {
      currentBid: room.auction.currentBid,
      currentLeader: room.auction.currentLeader,
      timerEnd: room.auction.timerEnd,
    },
    instances: room.instances.map(i => ({
      done: i.done,
      v: i.v,
      positions: i.positions,
      posTimerEnd: i.posTimerEnd,
    })),
    currentInstance: room.currentInstance,
    leaderboard: room.leaderboard,
    roundPnl: room.roundPnl,
    txLog: room.txLog,
  };
}

function computeScore(room) {
  let score = D(0);
  for (const c of room.community) score = score.plus((c.red ? -1 : 1) * cardVal(c.rank));
  for (const p of room.players) {
    for (const c of (room.hands[p.pid] || [])) score = score.plus((c.red ? -1 : 1) * cardVal(c.rank));
  }
  return score.toNumber();
}

function resolveAuction(room) {
  if (room.auction.timerHandle) clearTimeout(room.auction.timerHandle);
  room.auction.timerHandle = null;
  room.marketMaker = room.auction.currentLeader;
  room.spread = room.auction.currentBid;
  room.phase = 'market';
  broadcastRoom(room.id);
}

function startAuctionTimer(room) {
  if (room.auction.timerHandle) clearTimeout(room.auction.timerHandle);
  room.auction.timerEnd = Date.now() + AUCTION_SECONDS * 1000;
  room.auction.timerHandle = setTimeout(() => {
    const r = getRoom(room.id);
    if (r && r.phase === 'auction') resolveAuction(r);
  }, AUCTION_SECONDS * 1000);
}

function startPositionTimer(room) {
  const inst = room.instances[room.currentInstance];
  if (inst.posTimerHandle) clearTimeout(inst.posTimerHandle);
  inst.posTimerEnd = Date.now() + POSITION_SECONDS * 1000;
  inst.posTimerHandle = setTimeout(() => {
    const r = getRoom(room.id);
    if (!r || r.phase !== 'market') return;
    const i = r.instances[r.currentInstance];
    if (!i || i.done) return;
    // Default missing players to LONG
    const nonMM = r.players.filter(p => p.pid !== r.marketMaker);
    for (const p of nonMM) {
      if (!i.positions[p.pid]) {
        i.positions[p.pid] = 'long';
        r.txLogPending.push({
          type: 'buy',
          playerName: p.name,
          price: D(i.v).plus(D(r.spread)).toNumber(),
          instance: r.currentInstance + 1,
          ts: Date.now(),
          forced: true,
        });
      }
    }
    closeInstance(r);
  }, POSITION_SECONDS * 1000);
}

function closeInstance(room) {
  const inst = room.instances[room.currentInstance];
  if (inst.posTimerHandle) clearTimeout(inst.posTimerHandle);
  inst.posTimerHandle = null;
  inst.done = true;
  room.txLog.push(...room.txLogPending);
  room.txLogPending = [];
  if (room.currentInstance < 2) {
    room.currentInstance++;
  } else {
    finalizeRound(room);
  }
  broadcastRoom(room.id);
}

function finalizeRound(room) {
  const finalScore = computeScore(room);
  room.finalScore = finalScore;
  for (const p of room.players) room.roundPnl[p.pid] = 0;

  for (let idx = 0; idx < 3; idx++) {
    const inst = room.instances[idx];
    const buyPrice  = D(inst.v).plus(D(room.spread)).toNumber();
    const sellPrice = D(inst.v).toNumber();
    for (const p of room.players) {
      if (p.pid === room.marketMaker) continue;
      const pos = inst.positions[p.pid];
      if (pos === 'long') {
        room.roundPnl[p.pid]           = D(room.roundPnl[p.pid]).plus(D(finalScore).minus(D(buyPrice))).toNumber();
        room.roundPnl[room.marketMaker] = D(room.roundPnl[room.marketMaker]).plus(D(buyPrice).minus(D(finalScore))).toNumber();
      } else {
        room.roundPnl[p.pid]           = D(room.roundPnl[p.pid]).plus(D(sellPrice).minus(D(finalScore))).toNumber();
        room.roundPnl[room.marketMaker] = D(room.roundPnl[room.marketMaker]).plus(D(finalScore).minus(D(sellPrice))).toNumber();
      }
    }
  }
  for (const p of room.players) {
    if (!(p.pid in room.leaderboard)) room.leaderboard[p.pid] = 0;
    room.leaderboard[p.pid] = D(room.leaderboard[p.pid]).plus(D(room.roundPnl[p.pid])).toNumber();
  }
  room.phase = 'results';
}

// ── Socket handlers ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // pid = stable client-generated UUID; persists across reconnects
  socket.on('createRoom', ({ name, pid }) => {
    const roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
    const room = initRoom(roomId);
    room.players.push({ pid, name, socketId: socket.id, connected: true });
    room.host = pid;
    room.leaderboard[pid] = 0;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.pid = pid;
    broadcastRoom(roomId);
  });

  socket.on('joinRoom', ({ roomId, name, pid }) => {
    const room = getRoom(roomId);
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.phase !== 'lobby') { socket.emit('error', 'Game already in progress'); return; }
    // Prevent duplicate pid
    if (room.players.find(p => p.pid === pid)) {
      // already in room (e.g. page refresh in lobby) — just reattach
      const p = room.players.find(pl => pl.pid === pid);
      p.socketId = socket.id;
      p.connected = true;
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.pid = pid;
      broadcastRoom(roomId);
      return;
    }
    room.players.push({ pid, name, socketId: socket.id, connected: true });
    room.leaderboard[pid] = 0;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.pid = pid;
    broadcastRoom(roomId);
  });

  // Reconnect mid-game: client sends their stable pid
  socket.on('rejoinRoom', ({ roomId, pid }) => {
    const room = getRoom(roomId);
    if (!room) { socket.emit('error', 'Room not found'); return; }
    const player = room.players.find(p => p.pid === pid);
    if (!player) { socket.emit('error', 'Player not found in room'); return; }
    player.socketId = socket.id;
    player.connected = true;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.pid = pid;
    broadcastRoom(roomId);
  });

  socket.on('startGame', () => {
    const { roomId, pid } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.host !== pid) return;
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players'); return; }
    room.deck = newDeck();
    room.hands = {};
    for (const p of room.players) room.hands[p.pid] = [room.deck.pop(), room.deck.pop()];
    room.community = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
    room.instances = [
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
    ];
    room.currentInstance = 0;
    room.roundPnl = {};
    for (const p of room.players) room.roundPnl[p.pid] = 0;
    room.txLog = [];
    room.txLogPending = [];
    room.marketMaker = null;
    room.spread = 0;
    room.auction = { currentBid: null, currentLeader: null, timerEnd: null, timerHandle: null };
    room.phase = 'auction';
    broadcastRoom(roomId);
  });

  socket.on('submitBid', ({ bid }) => {
    const { roomId, pid } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'auction') return;
    // Must be non-negative integer
    if (!Number.isInteger(bid) || bid < 0) { socket.emit('error', 'Bid must be a non-negative integer'); return; }
    const curr = room.auction.currentBid;
    if (curr !== null && bid >= curr) { socket.emit('error', `Bid must be lower than ${curr}`); return; }
    room.auction.currentBid = bid;
    room.auction.currentLeader = pid;
    const bidderName = (room.players.find(p => p.pid === pid) || {}).name || '?';
    room.txLog.push({ type: 'bid', playerName: bidderName, spread: bid, ts: Date.now() });
    startAuctionTimer(room);
    broadcastRoom(roomId);
  });

  socket.on('postMarket', ({ v }) => {
    const { roomId, pid } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'market') return;
    if (room.marketMaker !== pid) return;
    const inst = room.instances[room.currentInstance];
    if (inst.v !== null || inst.done) return;
    inst.v = D(v).toNumber();
    startPositionTimer(room);
    broadcastRoom(roomId);
  });

  socket.on('takePosition', ({ position }) => {
    const { roomId, pid } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'market') return;
    if (room.marketMaker === pid) return;
    const inst = room.instances[room.currentInstance];
    if (inst.v === null || inst.done) return;
    if (!['long', 'short'].includes(position)) return;
    if (inst.positions[pid]) return;
    inst.positions[pid] = position;
    const pName = (room.players.find(p => p.pid === pid) || {}).name || '?';
    const buyPrice  = D(inst.v).plus(D(room.spread)).toNumber();
    const sellPrice = D(inst.v).toNumber();
    room.txLogPending.push({
      type: position === 'long' ? 'buy' : 'sell',
      playerName: pName,
      price: position === 'long' ? buyPrice : sellPrice,
      instance: room.currentInstance + 1,
      ts: Date.now(),
    });
    const nonMM = room.players.filter(p => p.pid !== room.marketMaker);
    if (nonMM.every(p => inst.positions[p.pid])) {
      closeInstance(room);
    } else {
      broadcastRoom(roomId);
    }
  });

  socket.on('newRound', () => {
    const { roomId, pid } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.host !== pid) return;
    room.phase = 'lobby';
    broadcastRoom(roomId);
  });

  socket.on('disconnect', () => {
    const { roomId, pid } = socket.data || {};
    if (!roomId || !pid) return;
    const room = getRoom(roomId);
    if (!room) return;
    const player = room.players.find(p => p.pid === pid);
    if (player) player.connected = false;
    if (room.host === pid) {
      const next = room.players.find(p => p.pid !== pid && p.connected !== false);
      if (next) room.host = next.pid;
    }
    // Clean up empty rooms after 10 min
    if (room.players.every(p => !p.connected)) {
      setTimeout(() => {
        const r = getRoom(roomId);
        if (r && r.players.every(p => !p.connected)) delete rooms[roomId];
      }, 10 * 60 * 1000);
    }
    broadcastRoom(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Hold'Ex running on http://localhost:${PORT}`));
