const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, red: isRed(s) });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

const AUCTION_SECONDS = 8;

function initRoom(roomId) {
  rooms[roomId] = {
    id: roomId,
    phase: 'lobby',
    players: [],
    host: null,
    deck: [],
    hands: {},
    community: [],
    marketMaker: null,
    spread: 0,
    // Descending auction state
    auction: {
      currentBid: null,   // current lowest bid on the table
      currentLeader: null, // playerId of current leader
      timerEnd: null,      // epoch ms when timer expires
      timerHandle: null,   // server-side setTimeout handle
    },
    instances: [
      { done: false, v: null, positions: {} },
      { done: false, v: null, positions: {} },
      { done: false, v: null, positions: {} },
    ],
    currentInstance: 0,
    leaderboard: {},
    roundPnl: {},
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
      // MM can see who has positioned (but not their cards until results)
      hands[p.id] = (room.hands[p.id] || []).map(() => null);
    }
  }

  let visibleCommunity = room.community;
  if (room.phase === 'market') {
    const fc = [0, 3, 5][room.currentInstance];
    visibleCommunity = room.community.map((c, i) => i < fc ? c : null);
  }
  if (room.phase !== 'market' && room.phase !== 'results') {
    visibleCommunity = room.community.map(() => null);
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
    auction: {
      currentBid: room.auction.currentBid,
      currentLeader: room.auction.currentLeader,
      timerEnd: room.auction.timerEnd,
    },
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

io.on('connection', (socket) => {

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
    room.roundPnl = {};
    for (const p of room.players) room.roundPnl[p.id] = 0;

    // Reset auction state — no opening bid yet
    room.auction = { currentBid: null, currentLeader: null, timerEnd: null, timerHandle: null };
    room.phase = 'auction';
    broadcastRoom(roomId);
  });

  // Descending auction: player submits a bid lower than current
  socket.on('submitBid', ({ bid }) => {
    const { roomId, playerId } = socket.data;
    const room = getRoom(roomId);
    if (!room || room.phase !== 'auction') return;
    if (typeof bid !== 'number' || bid < 0) return;

    const curr = room.auction.currentBid;

    // First bid: any value is accepted
    // Subsequent bids: must be strictly lower than current
    if (curr !== null && bid >= curr) {
      socket.emit('error', `Bid must be lower than current bid of ${curr}`);
      return;
    }

    // New leading bid — reset timer
    room.auction.currentBid = bid;
    room.auction.currentLeader = playerId;
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
    inst.v = v;
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
    inst.positions[playerId] = position;

    const nonMM = room.players.filter(p => p.id !== room.marketMaker);
    if (nonMM.every(p => inst.positions[p.id])) {
      inst.done = true;
      if (room.currentInstance < 2) {
        room.currentInstance++;
      } else {
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
          room.roundPnl[p.id] += (finalScore - buyPrice);
          room.roundPnl[room.marketMaker] += (buyPrice - finalScore);
        } else {
          room.roundPnl[p.id] += (sellPrice - finalScore);
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
    if (room.auction.timerHandle && room.auction.currentLeader === playerId) {
      clearTimeout(room.auction.timerHandle);
      room.auction.timerHandle = null;
    }
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
