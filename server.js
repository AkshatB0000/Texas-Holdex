const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Game state store (keyed by roomId) ──────────────────────────────────────
const rooms = {};

const SUITS = ['♠', '♣', '♥', '♦'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function isRed(suit) { return suit === '♥' || suit === '♦'; }
function cardVal(rank) {
  if (rank === 'A') return 11;
  if (['J','Q','K'].includes(rank)) return 10;
  return parseInt(rank);
}

function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, red: isRed(s) });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function initRoom(roomId) {
  rooms[roomId] = {
    id: roomId,
    phase: 'lobby',       // lobby | auction | market | results
    players: [],          // [{ id, name, socketId }]
    host: null,
    deck: [],
    hands: {},            // playerId -> [card, card]
    community: [],
    marketMaker: null,    // playerId
    spread: 0,
    bids: {},             // playerId -> number
    instances: [
      { done: false, v: null, positions: {} },
      { done: false, v: null, positions: {} },
      { done: false, v: null, positions: {} },
    ],
    currentInstance: 0,
    leaderboard: {},      // playerId -> cumulative pnl
    roundPnl: {},         // playerId -> this round pnl
  };
  return rooms[roomId];
}

function getRoom(roomId) { return rooms[roomId]; }

function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  // Send each player a personalised view (they only see their own hand)
  for (const player of room.players) {
    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket) continue;
    socket.emit('state', buildClientState(room, player.id));
  }
}

function buildClientState(room, playerId) {
  // Sanitise: other players' hands are hidden until results phase
  const hands = {};
  for (const p of room.players) {
    if (p.id === playerId || room.phase === 'results') {
      hands[p.id] = room.hands[p.id] || [];
    } else {
      hands[p.id] = (room.hands[p.id] || []).map(() => null); // hidden
    }
  }

  // Community cards: reveal based on current instance
  let visibleCommunity = room.community;
  if (room.phase === 'market') {
    const fc = [0, 3, 5][room.currentInstance];
    visibleCommunity = room.community.map((c, i) => i < fc ? c : null);
  }
  if (room.phase === 'results') {
    visibleCommunity = room.community;
  }

  return {
    roomId: room.id,
    phase: room.phase,
    players: room.players,
    host: room.host,
    myId: playerId,
    hands,
    community: visibleCommunity,
    marketMaker: room.marketMaker,
    spread: room.spread,
    bids: room.bids,
    instances: room.instances,
    currentInstance: room.currentInstance,
    leaderboard: room.leaderboard,
    roundPnl: room.roundPnl,
  };
}

function computeScore(room) {
  let score = 0;
  for (const c of room.community) score += (c.red ? -1 : 1) * cardVal(c.rank);
  for (const p of room.players) {
    for (const c of (room.hands[p.id] || [])) score += (c.red ? -1 : 1) * cardVal(c.rank);
  }
  return score;
}

// ── Socket handlers ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Create a new room
  socket.on('createRoom', ({ name }) => {
    const roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
    const room = initRoom(roomId);
    const playerId = socket.id;
    room.players.push({ id: playerId, name, socketId: socket.id });
    room.host = playerId;
    room.leaderboard[playerId] = 0;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    broadcastRoom(roomId);
  });

  // Join existing room
  socket.on('joinRoom', ({ roomId, name }) => {
    const room = getRoom(roomId);
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.phase !== 'lobby') { socket.emit('error', 'Game already in progress'); return; }
    const playerId = socket.id;
    room.players.push({ id: playerId, name, socketId: socket.id });
    room.leaderboard[playerId] = 0;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    broadcastRoom(roomId);
  });

  // Host starts the game
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
      { done: false, v: null, positions: {} },
      { done: false, v: null, positions: {} },
      { done: false, v: null, positions: {} },
    ];
    room.currentInstance = 0;
    room.bids = {};
    room.roundPnl = {};
    for (const p of room.players) room.roundPnl[p.id] = 0;
    room.phase = 'auction';
    broadcastRoom(roomId);
  });

  // Player submits auction bid
  socket.on('submitBid', ({ bid }) => {
    const { roomId, playerId } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'auction') return;
    if (typeof bid !== 'number' || bid < 0) return;
    room.bids[playerId] = bid;

    // If all players have bid, resolve automatically
    if (Object.keys(room.bids).length === room.players.length) {
      resolveAuction(room);
    }
    broadcastRoom(roomId);
  });

  function resolveAuction(room) {
    const entries = Object.entries(room.bids);
    const minBid = Math.min(...entries.map(([, v]) => v));
    const tied = entries.filter(([, v]) => v === minBid);
    // Random tie-break
    const [winnerId] = tied[Math.floor(Math.random() * tied.length)];
    room.marketMaker = winnerId;
    room.spread = minBid;
    room.phase = 'market';
  }

  // Market maker posts a sell price v for the current instance
  socket.on('postMarket', ({ v }) => {
    const { roomId, playerId } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'market') return;
    if (room.marketMaker !== playerId) return;
    const inst = room.instances[room.currentInstance];
    if (inst.v !== null || inst.done) return;
    inst.v = v;
    broadcastRoom(roomId);
  });

  // Non-MM player takes a position (long/short) on the current instance
  socket.on('takePosition', ({ position }) => {
    const { roomId, playerId } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'market') return;
    if (room.marketMaker === playerId) return;
    const inst = room.instances[room.currentInstance];
    if (inst.v === null || inst.done) return;
    if (!['long', 'short'].includes(position)) return;
    inst.positions[playerId] = position;

    // Check if all non-MM players have positioned
    const nonMM = room.players.filter(p => p.id !== room.marketMaker);
    if (nonMM.every(p => inst.positions[p.id])) {
      inst.done = true;
      if (room.currentInstance < 2) {
        room.currentInstance++;
      } else {
        // All 3 instances done — compute results
        finalizeRound(room);
      }
    }
    broadcastRoom(roomId);
  });

  function finalizeRound(room) {
    const finalScore = computeScore(room);
    room.finalScore = finalScore;

    for (const p of room.players) room.roundPnl[p.id] = 0;

    for (let idx = 0; idx < 3; idx++) {
      const inst = room.instances[idx];
      const buyPrice = inst.v + room.spread;
      const sellPrice = inst.v;
      for (const p of room.players) {
        if (p.id === room.marketMaker) continue;
        const pos = inst.positions[p.id];
        if (pos === 'long') {
          // Player bought at buyPrice (v+k)
          room.roundPnl[p.id] += (finalScore - buyPrice);
          // MM sold at buyPrice (v+k), so MM is short: earns (v+k) - finalScore
          room.roundPnl[room.marketMaker] += (buyPrice - finalScore);
        } else {
          // Player sold at sellPrice (v)
          room.roundPnl[p.id] += (sellPrice - finalScore);
          // MM bought at sellPrice (v), so MM is long: earns finalScore - v
          room.roundPnl[room.marketMaker] += (finalScore - sellPrice);
        }
      }
    }

    for (const p of room.players) {
      if (!(p.id in room.leaderboard)) room.leaderboard[p.id] = 0;
      room.leaderboard[p.id] += room.roundPnl[p.id];
    }
    room.phase = 'results';
  }

  // Host starts a new round
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
    const room = getRoom(roomId);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== playerId);
    if (room.players.length === 0) {
      delete rooms[roomId];
    } else {
      if (room.host === playerId) room.host = room.players[0].id;
      broadcastRoom(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Hold'Ex server running on http://localhost:${PORT}`));
