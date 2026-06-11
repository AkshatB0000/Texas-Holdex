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

// Map socketId -> { roomId, playerId, name } for reconnect support
const socketMap = {};

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

// All arithmetic via Decimal to avoid float issues
function D(x) { return new Decimal(x); }
function add(a, b) { return D(a).plus(D(b)).toNumber(); }
function sub(a, b) { return D(a).minus(D(b)).toNumber(); }

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
    players: [],          // { id, name, socketId, connected }
    host: null,
    deck: [],
    hands: {},
    community: [],
    marketMaker: null,
    spread: 0,
    auction: {
      currentBid: null,
      currentLeader: null,
      timerEnd: null,
      timerHandle: null,
    },
    instances: [
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
    ],
    currentInstance: 0,
    leaderboard: {},
    roundPnl: {},
    txLog: [],          // revealed to all only after all positioned per instance
    txLogPending: [],   // held until instance done
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
    socket.emit('state', buildClientState(room, player.id));
  }
}

function buildClientState(room, playerId) {
  const hands = {};
  for (const p of room.players) {
    if (p.id === playerId || room.phase === 'results') {
      hands[p.id] = room.hands[p.id] || [];
    } else {
      hands[p.id] = (room.hands[p.id] || []).map(() => null);
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

  // Position timer for current instance
  const inst = room.instances[room.currentInstance] || {};

  return {
    roomId: room.id,
    phase: room.phase,
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected !== false })),
    host: room.host,
    myId: playerId,
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
  for (const c of room.community) score = score.plus(D((c.red ? -1 : 1) * cardVal(c.rank)));
  for (const p of room.players) {
    for (const c of (room.hands[p.id] || [])) score = score.plus(D((c.red ? -1 : 1) * cardVal(c.rank)));
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

// Start 40s position timer for current instance
function startPositionTimer(room) {
  const inst = room.instances[room.currentInstance];
  if (inst.posTimerHandle) clearTimeout(inst.posTimerHandle);
  inst.posTimerEnd = Date.now() + POSITION_SECONDS * 1000;
  inst.posTimerHandle = setTimeout(() => {
    const r = getRoom(room.id);
    if (!r || r.phase !== 'market') return;
    const i = r.instances[r.currentInstance];
    if (!i || i.done) return;
    // Force-submit missing positions: default to short for any missing player
    const nonMM = r.players.filter(p => p.id !== r.marketMaker);
    for (const p of nonMM) {
      if (!i.positions[p.id]) {
        i.positions[p.id] = 'short';
        r.txLogPending.push({
          type: 'sell',
          playerName: p.name,
          price: i.v,
          instance: r.currentInstance + 1,
          ts: Date.now(),
          forced: true,
        });
      }
    }
    closeInstance(r);
  }, POSITION_SECONDS * 1000);
  broadcastRoom(room.id);
}

function closeInstance(room) {
  const inst = room.instances[room.currentInstance];
  if (inst.posTimerHandle) clearTimeout(inst.posTimerHandle);
  inst.posTimerHandle = null;
  inst.done = true;
  // Flush pending tx log entries now that all have positioned
  room.txLog.push(...room.txLogPending);
  room.txLogPending = [];
  if (room.currentInstance < 2) {
    room.currentInstance++;
  } else {
    finalizeRound(room);
  }
  broadcastRoom(room.id);
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }) => {
    const roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
    const room = initRoom(roomId);
    const playerId = socket.id;
    room.players.push({ id: playerId, name, socketId: socket.id, connected: true });
    room.host = playerId;
    room.leaderboard[playerId] = 0;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    socketMap[socket.id] = { roomId, playerId, name };
    broadcastRoom(roomId);
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    const room = getRoom(roomId);
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.phase !== 'lobby') { socket.emit('error', 'Game already in progress'); return; }
    const playerId = socket.id;
    room.players.push({ id: playerId, name, socketId: socket.id, connected: true });
    room.leaderboard[playerId] = 0;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    socketMap[socket.id] = { roomId, playerId, name };
    broadcastRoom(roomId);
  });

  // Reconnect: player rejoins mid-game with their original name
  socket.on('rejoinRoom', ({ roomId, name }) => {
    const room = getRoom(roomId);
    if (!room) { socket.emit('error', 'Room not found'); return; }
    // Find disconnected player with same name
    const existing = room.players.find(p => p.name === name && p.connected === false);
    if (!existing) { socket.emit('error', 'No disconnected player found with that name'); return; }
    const oldSocketId = existing.socketId;
    existing.socketId = socket.id;
    existing.connected = true;
    socket.data.roomId = roomId;
    socket.data.playerId = existing.id;
    socketMap[socket.id] = { roomId, playerId: existing.id, name };
    delete socketMap[oldSocketId];
    socket.join(roomId);
    broadcastRoom(roomId);
  });

  socket.on('startGame', () => {
    const { roomId, playerId } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.host !== playerId) return;
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players'); return; }

    room.deck = newDeck();
    room.hands = {};
    for (const p of room.players) {
      room.hands[p.id] = [room.deck.pop(), room.deck.pop()];
    }
    room.community = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
    room.instances = [
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
      { done: false, v: null, positions: {}, posTimerEnd: null, posTimerHandle: null },
    ];
    room.currentInstance = 0;
    room.roundPnl = {};
    for (const p of room.players) room.roundPnl[p.id] = 0;
    room.txLog = [];
    room.txLogPending = [];
    room.auction = { currentBid: null, currentLeader: null, timerEnd: null, timerHandle: null };
    room.phase = 'auction';
    broadcastRoom(roomId);
  });

  socket.on('submitBid', ({ bid }) => {
    const { roomId, playerId } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'auction') return;
    if (typeof bid !== 'number' || bid < 0) return;
    const curr = room.auction.currentBid;
    if (curr !== null && D(bid).gte(D(curr))) {
      socket.emit('error', `Bid must be lower than current bid of ${curr}`);
      return;
    }
    room.auction.currentBid = D(bid).toNumber();
    room.auction.currentLeader = playerId;
    const bidderName = (room.players.find(p => p.id === playerId) || {}).name || 'Unknown';
    room.txLog.push({ type: 'bid', playerName: bidderName, spread: room.auction.currentBid, ts: Date.now() });
    startAuctionTimer(room);
    broadcastRoom(roomId);
  });

  socket.on('postMarket', ({ v }) => {
    const { roomId, playerId } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'market') return;
    if (room.marketMaker !== playerId) return;
    const inst = room.instances[room.currentInstance];
    if (inst.v !== null || inst.done) return;
    inst.v = D(v).toNumber();
    // Start position timer now that price is posted
    startPositionTimer(room);
    broadcastRoom(roomId);
  });

  socket.on('takePosition', ({ position }) => {
    const { roomId, playerId } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'market') return;
    if (room.marketMaker === playerId) return;
    const inst = room.instances[room.currentInstance];
    if (inst.v === null || inst.done) return;
    if (!['long', 'short'].includes(position)) return;
    if (inst.positions[playerId]) return; // already positioned

    inst.positions[playerId] = position;
    const pName = (room.players.find(p => p.id === playerId) || {}).name || 'Unknown';
    const buyPrice = D(inst.v).plus(D(room.spread)).toNumber();
    const sellPrice = D(inst.v).toNumber();

    // Queue in pending — revealed to all after instance closes
    room.txLogPending.push({
      type: position === 'long' ? 'buy' : 'sell',
      playerName: pName,
      price: position === 'long' ? buyPrice : sellPrice,
      instance: room.currentInstance + 1,
      ts: Date.now(),
    });

    const nonMM = room.players.filter(p => p.id !== room.marketMaker);
    if (nonMM.every(p => inst.positions[p.id])) {
      closeInstance(room);
    } else {
      broadcastRoom(roomId);
    }
  });

  function finalizeRound(room) {
    const finalScore = computeScore(room);
    room.finalScore = finalScore;

    for (const p of room.players) room.roundPnl[p.id] = 0;

    for (let idx = 0; idx < 3; idx++) {
      const inst = room.instances[idx];
      const buyPrice = D(inst.v).plus(D(room.spread)).toNumber();
      const sellPrice = D(inst.v).toNumber();
      for (const p of room.players) {
        if (p.id === room.marketMaker) continue;
        const pos = inst.positions[p.id];
        if (pos === 'long') {
          room.roundPnl[p.id] = D(room.roundPnl[p.id]).plus(D(finalScore).minus(D(buyPrice))).toNumber();
          room.roundPnl[room.marketMaker] = D(room.roundPnl[room.marketMaker]).plus(D(buyPrice).minus(D(finalScore))).toNumber();
        } else {
          room.roundPnl[p.id] = D(room.roundPnl[p.id]).plus(D(sellPrice).minus(D(finalScore))).toNumber();
          room.roundPnl[room.marketMaker] = D(room.roundPnl[room.marketMaker]).plus(D(finalScore).minus(D(sellPrice))).toNumber();
        }
      }
    }

    for (const p of room.players) {
      if (!(p.id in room.leaderboard)) room.leaderboard[p.id] = 0;
      room.leaderboard[p.id] = D(room.leaderboard[p.id]).plus(D(room.roundPnl[p.id])).toNumber();
    }
    room.phase = 'results';
  }

  socket.on('newRound', () => {
    const { roomId, playerId } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.host !== playerId) return;
    room.phase = 'lobby';
    broadcastRoom(roomId);
  });

  socket.on('disconnect', () => {
    const { roomId, playerId } = socket.data || {};
    if (!roomId || !playerId) return;
    delete socketMap[socket.id];
    const room = getRoom(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (player) {
      // Mark disconnected but keep in game — allow rejoin
      player.connected = false;
    }
    // If all players disconnected, clean up after 10 min
    if (room.players.every(p => !p.connected)) {
      setTimeout(() => {
        const r = getRoom(roomId);
        if (r && r.players.every(p => !p.connected)) delete rooms[roomId];
      }, 10 * 60 * 1000);
    }
    if (room.host === playerId) {
      const next = room.players.find(p => p.id !== playerId && p.connected !== false);
      if (next) room.host = next.id;
    }
    broadcastRoom(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Hold'Ex server running on http://localhost:${PORT}`));
