import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const port = process.env.PORT || 3001;

// CORS 支持（用于开发环境）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

const server = app.listen(port, () => {
  console.log(`德州扑克后端服务已启动，端口：${port}`);
});

const wss = new WebSocketServer({ server });

// ========== 游戏配置 ==========
const BIG_BLIND = 10;
const SMALL_BLIND = 5;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 9;

// ========== 扑克牌逻辑 ==========
function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function evaluateHand(cards) {
  const rankValues = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
  const values = cards.map(c => rankValues[c.rank]).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = values.every((v, i) => i === 0 || v === values[i - 1] - 1) || (values.join(',') === '14,5,4,3,2');

  const pairs = {};
  values.forEach(v => { pairs[v] = (pairs[v] || 0) + 1; });
  const pairCount = Object.values(pairs).filter(c => c === 2).length;
  const threeOfKind = Object.values(pairs).some(c => c === 3);
  const fourOfKind = Object.values(pairs).some(c => c === 4);

  if (isFlush && isStraight) return { rank: 9, name: '皇家同花顺' };
  if (isFlush) return { rank: 6, name: '同花' };
  if (isStraight) return { rank: 5, name: '顺子' };
  if (fourOfKind) return { rank: 8, name: '四条' };
  if (threeOfKind && pairCount === 1) return { rank: 7, name: '葫芦' };
  if (threeOfKind) return { rank: 4, name: '三条' };
  if (pairCount === 2) return { rank: 3, name: '两对' };
  if (pairCount === 1) return { rank: 2, name: '一对' };
  return { rank: 1, name: '高牌' };
}

function compareHands(hand1, hand2) {
  const eval1 = evaluateHand(hand1);
  const eval2 = evaluateHand(hand2);
  if (eval1.rank !== eval2.rank) return eval1.rank - eval2.rank;
  return 0;
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.hasFolded && !p.isAllIn);
}

function getNextActivePlayer(room, fromIndex) {
  const active = room.players.filter(p => !p.hasFolded && !p.isAllIn);
  if (active.length <= 1) return -1;

  let attempts = 0;
  let nextIndex = (fromIndex + 1) % room.players.length;
  while (attempts < room.players.length) {
    const p = room.players[nextIndex];
    if (!p.hasFolded && !p.isAllIn) return nextIndex;
    nextIndex = (nextIndex + 1) % room.players.length;
    attempts++;
  }
  return -1;
}

function allActivePlayersActed(room) {
  const active = getActivePlayers(room);
  if (active.length <= 1) return true;
  return active.every(p => p.hasActed);
}

function canPlayerAct(room, player) {
  return !player.hasFolded && !player.isAllIn;
}

// ========== 房间管理 ==========
const rooms = new Map();
let roomCounter = 1000;

function generateRoomId() {
  return `ROOM${++roomCounter}`;
}

function createRoom(ws, hostName) {
  const roomId = generateRoomId();
  const room = {
    id: roomId,
    players: [],
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    phase: 'waiting',
    dealerIndex: 0,
    currentPlayerIndex: 0,
    gameStarted: false,
    lastActions: [],
    wsToPlayer: new Map(),
  };
  rooms.set(roomId, room);
  return room;
}

function getAvailableRooms() {
  return Array.from(rooms.values())
    .filter(r => r.phase === 'waiting' && r.players.length < MAX_PLAYERS)
    .map(r => ({ id: r.id, playerCount: r.players.length, maxPlayers: MAX_PLAYERS }));
}

function dealCards(room) {
  room.deck = shuffleDeck(createDeck());
  room.communityCards = [];
  for (const player of room.players) {
    player.hand = [room.deck.pop(), room.deck.pop()];
    player.hasActed = false;
    player.currentBet = 0;
    player.hasFolded = false;
    player.isAllIn = false;
  }
}

function dealCommunityCards(room, count) {
  for (let i = 0; i < count; i++) {
    room.communityCards.push(room.deck.pop());
  }
}

function resetBettingRound(room) {
  room.currentBet = 0;
  room.lastActions = [];
  for (const player of room.players) {
    player.hasActed = false;
    player.currentBet = 0;
  }
}

function advanceGame(room) {
  const activePlayers = getActivePlayers(room);

  // 如果只剩一个玩家，他获胜
  if (activePlayers.length === 1) {
    room.phase = 'showdown';
    activePlayers[0].chips += room.pot;
    broadcastToRoom(room, {
      type: 'game_end',
      winner: activePlayers[0].name,
      winnerId: activePlayers[0].id,
      reason: '对手弃牌',
      hand: activePlayers[0].hand,
      communityCards: room.communityCards,
      pot: room.pot,
      isShowdown: false
    });
    return;
  }

  switch (room.phase) {
    case 'waiting':
      // 开始新游戏
      room.dealerIndex = 0;
      room.gameStarted = true;
      room.phase = 'preflop';
      room.pot = 0;
      dealCards(room);

      // 发送发牌
      for (const player of room.players) {
        sendToPlayer(player, {
          type: 'deal',
          hand: player.hand
        });
      }

      // 设置盲注
      const sbIndex = (room.dealerIndex + 1) % room.players.length;
      const bbIndex = (room.dealerIndex + 2) % room.players.length;
      const sbPlayer = room.players[sbIndex];
      const bbPlayer = room.players[bbIndex];

      sbPlayer.chips -= SMALL_BLIND;
      sbPlayer.currentBet = SMALL_BLIND;
      room.pot += SMALL_BLIND;

      bbPlayer.chips -= BIG_BLIND;
      bbPlayer.currentBet = BIG_BLIND;
      room.pot += BIG_BLIND;
      room.currentBet = BIG_BLIND;

      // 第一轮下注从小盲位开始（大盲位后面）
      room.currentPlayerIndex = (room.dealerIndex + 1) % room.players.length;

      broadcastToRoom(room, {
        type: 'game_start',
        dealerIndex: room.dealerIndex,
        sbPlayer: sbPlayer.id,
        sbPlayerName: sbPlayer.name,
        bbPlayer: bbPlayer.id,
        bbPlayerName: bbPlayer.name,
        pot: room.pot,
        currentBet: room.currentBet,
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          chips: p.chips,
          currentBet: p.currentBet,
          hasFolded: p.hasFolded,
          isAllIn: p.isAllIn
        }))
      });

      // 发给小盲注玩家行动提示
      setTimeout(() => {
        if (room.phase === 'preflop') {
          sendTurnUpdate(room);
        }
      }, 500);
      break;

    case 'preflop':
      room.phase = 'flop';
      dealCommunityCards(room, 3);
      resetBettingRound(room);
      room.currentPlayerIndex = (room.dealerIndex + 1) % room.players.length;

      broadcastToRoom(room, {
        type: 'flop',
        cards: room.communityCards,
        pot: room.pot
      });

      setTimeout(() => {
        if (room.phase === 'flop') {
          sendTurnUpdate(room);
        }
      }, 500);
      break;

    case 'flop':
      room.phase = 'turn';
      dealCommunityCards(room, 1);
      resetBettingRound(room);

      broadcastToRoom(room, {
        type: 'phase_turn',
        card: room.communityCards[3],
        pot: room.pot
      });

      setTimeout(() => {
        if (room.phase === 'turn') {
          sendTurnUpdate(room);
        }
      }, 500);
      break;

    case 'turn':
      room.phase = 'river';
      dealCommunityCards(room, 1);
      resetBettingRound(room);

      broadcastToRoom(room, {
        type: 'phase_river',
        card: room.communityCards[4],
        pot: room.pot
      });

      setTimeout(() => {
        if (room.phase === 'river') {
          sendTurnUpdate(room);
        }
      }, 500);
      break;

    case 'river':
      room.phase = 'showdown';

      // 计算所有玩家的牌力并排序
      const results = [];
      for (const player of room.players) {
        if (!player.hasFolded) {
          const allCards = [...player.hand, ...room.communityCards];
          const evalResult = evaluateHand(allCards);
          results.push({ player, eval: evalResult, hand: player.hand });
        }
      }
      results.sort((a, b) => {
        const cmp = compareHands(a.hand, b.hand);
        return cmp > 0 ? -1 : 1;
      });

      const winner = results[0].player;
      winner.chips += room.pot;

      broadcastToRoom(room, {
        type: 'showdown',
        winner: winner.name,
        winnerId: winner.id,
        results: results.map(r => ({
          name: r.player.name,
          hand: r.hand,
          eval: r.eval.name
        })),
        communityCards: room.communityCards,
        pot: room.pot
      });
      break;

    case 'showdown':
      // 重置准备下一局
      room.phase = 'waiting';
      room.gameStarted = false;
      room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
      room.communityCards = [];
      room.currentBet = 0;
      room.pot = 0;
      for (const player of room.players) {
        player.hand = [];
        player.hasFolded = false;
        player.isAllIn = false;
        player.currentBet = 0;
        player.hasActed = false;
      }
      broadcastToRoom(room, { type: 'new_round' });
      break;
  }
}

function sendTurnUpdate(room) {
  const currentPlayer = room.players[room.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.hasFolded || currentPlayer.isAllIn) {
    // 尝试找下一个可以行动的玩家
    const nextIndex = getNextActivePlayer(room, room.currentPlayerIndex);
    if (nextIndex === -1) {
      advanceGame(room);
      return;
    }
    room.currentPlayerIndex = nextIndex;
    return sendTurnUpdate(room);
  }

  const toCall = room.currentBet - currentPlayer.currentBet;

  broadcastToRoom(room, {
    type: 'player_turn',
    playerId: currentPlayer.id,
    playerName: currentPlayer.name,
    canCheck: toCall === 0,
    toCall: toCall,
    minRaise: room.currentBet > 0 ? room.currentBet * 2 : BIG_BLIND * 2,
    pot: room.pot,
    phase: room.phase
  });
}

function handleAction(room, player, action, amount) {
  const currentPlayer = room.players[room.currentPlayerIndex];

  // 检查是否是当前玩家在行动
  if (currentPlayer.id !== player.id) {
    sendToPlayer(player, { type: 'error', message: '还没轮到你行动，请等待其他玩家' });
    return;
  }

  const toCall = room.currentBet - player.currentBet;

  switch (action) {
    case 'fold':
      player.hasFolded = true;
      player.hasActed = true;
      broadcastToRoom(room, { type: 'action_log', player: player.name, action: 'fold' });
      break;

    case 'check':
      if (toCall > 0) {
        sendToPlayer(player, { type: 'error', message: '需要跟注才能过牌' });
        return;
      }
      player.hasActed = true;
      broadcastToRoom(room, { type: 'action_log', player: player.name, action: 'check' });
      break;

    case 'call':
      if (toCall <= 0) {
        sendToPlayer(player, { type: 'error', message: '不需要跟注' });
        return;
      }
      const callAmount = Math.min(toCall, player.chips);
      player.chips -= callAmount;
      player.currentBet += callAmount;
      room.pot += callAmount;
      player.hasActed = true;
      if (player.chips === 0) player.isAllIn = true;
      broadcastToRoom(room, { type: 'action_log', player: player.name, action: 'call', amount: callAmount, pot: room.pot });
      break;

    case 'raise':
      const raiseTotal = amount;
      if (raiseTotal <= room.currentBet) {
        sendToPlayer(player, { type: 'error', message: '加注金额必须大于当前下注' });
        return;
      }
      if (raiseTotal > player.chips + player.currentBet) {
        sendToPlayer(player, { type: 'error', message: '筹码不足' });
        return;
      }
      const raiseAmount = raiseTotal - player.currentBet;
      player.chips -= raiseAmount;
      player.currentBet = raiseTotal;
      room.pot += raiseAmount;
      room.currentBet = raiseTotal;
      player.hasActed = true;
      if (player.chips === 0) player.isAllIn = true;
      broadcastToRoom(room, { type: 'action_log', player: player.name, action: 'raise', amount: raiseAmount, totalBet: raiseTotal, pot: room.pot });
      break;

    case 'allin':
      const allInAmount = player.chips;
      player.chips = 0;
      player.isAllIn = true;
      player.hasActed = true;
      const newBet = player.currentBet + allInAmount;
      if (newBet > room.currentBet) {
        room.currentBet = newBet;
      }
      room.pot += allInAmount;
      broadcastToRoom(room, { type: 'action_log', player: player.name, action: 'allin', amount: allInAmount, pot: room.pot });
      break;
  }

  // 发送状态更新
  broadcastStateUpdate(room);

  // 检查是否所有人都行动了
  if (allActivePlayersActed(room)) {
    advanceGame(room);
  } else {
    // 移动到下一个玩家
    const nextIndex = getNextActivePlayer(room, room.currentPlayerIndex);
    if (nextIndex === -1) {
      advanceGame(room);
    } else {
      room.currentPlayerIndex = nextIndex;
      setTimeout(() => sendTurnUpdate(room), 300);
    }
  }
}

function broadcastStateUpdate(room) {
  broadcastToRoom(room, {
    type: 'state_update',
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      currentBet: p.currentBet,
      hasFolded: p.hasFolded,
      isAllIn: p.isAllIn
    })),
    pot: room.pot,
    currentBet: room.currentBet,
    phase: room.phase
  });
}

function broadcastToRoom(room, message, excludeWs = null) {
  const data = JSON.stringify(message);
  for (const [ws, player] of room.wsToPlayer) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function sendToPlayer(player, message) {
  if (player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify(message));
  }
}

function handleDisconnect(room, player) {
  const index = room.players.findIndex(p => p.id === player.id);
  if (index !== -1) {
    room.players.splice(index, 1);
    room.wsToPlayer.delete(player.ws);
  }

  if (room.players.length === 0) {
    rooms.delete(room.id);
    return;
  }

  // 如果游戏进行中，通知其他玩家
  if (room.phase !== 'waiting') {
    const activePlayers = getActivePlayers(room);
    if (activePlayers.length === 1) {
      activePlayers[0].chips += room.pot;
      broadcastToRoom(room, {
        type: 'game_end',
        winner: activePlayers[0].name,
        winnerId: activePlayers[0].id,
        reason: '对手退出',
        pot: room.pot
      });
      room.phase = 'waiting';
      room.gameStarted = false;
    } else if (room.currentPlayerIndex >= room.players.length) {
      room.currentPlayerIndex = 0;
    }
  }

  broadcastToRoom(room, {
    type: 'player_left',
    player: player.name,
    players: room.players.map(p => ({ id: p.id, name: p.name, chips: p.chips }))
  });
}

// ========== WebSocket 处理 ==========
wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentPlayer = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'create_room':
          const hostName = message.name || '玩家';
          const room = createRoom(ws, hostName);
          currentPlayer = {
            id: `p${Date.now()}`,
            name: hostName,
            ws,
            chips: 1000,
            hand: [],
            hasFolded: false,
            isAllIn: false,
            currentBet: 0,
            hasActed: false
          };
          room.players.push(currentPlayer);
          room.wsToPlayer.set(ws, currentPlayer);
          currentRoom = room;
          ws.send(JSON.stringify({
            type: 'room_created',
            roomId: room.id,
            player: { id: currentPlayer.id, name: currentPlayer.name, chips: currentPlayer.chips }
          }));
          break;

        case 'join_room':
          const joinRoom = rooms.get(message.roomId);
          if (!joinRoom) {
            ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
            return;
          }
          if (joinRoom.phase !== 'waiting') {
            ws.send(JSON.stringify({ type: 'error', message: '游戏已开始，无法加入' }));
            return;
          }
          if (joinRoom.players.length >= MAX_PLAYERS) {
            ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
            return;
          }
          const playerName = message.name || '玩家';
          currentPlayer = {
            id: `p${Date.now()}`,
            name: playerName,
            ws,
            chips: 1000,
            hand: [],
            hasFolded: false,
            isAllIn: false,
            currentBet: 0,
            hasActed: false
          };
          joinRoom.players.push(currentPlayer);
          joinRoom.wsToPlayer.set(ws, currentPlayer);
          currentRoom = joinRoom;
          ws.send(JSON.stringify({
            type: 'joined',
            roomId: joinRoom.id,
            player: { id: currentPlayer.id, name: currentPlayer.name, chips: currentPlayer.chips },
            players: joinRoom.players.map(p => ({ id: p.id, name: p.name, chips: p.chips }))
          }));
          broadcastToRoom(joinRoom, {
            type: 'player_joined',
            player: { id: currentPlayer.id, name: currentPlayer.name, chips: currentPlayer.chips },
            players: joinRoom.players.map(p => ({ id: p.id, name: p.name, chips: p.chips }))
          }, ws);
          break;

        case 'list_rooms':
          ws.send(JSON.stringify({ type: 'rooms_list', rooms: getAvailableRooms() }));
          break;

        case 'start_game':
          if (!currentRoom) return;
          if (currentRoom.players[0].id !== currentPlayer.id) {
            ws.send(JSON.stringify({ type: 'error', message: '只有房主可以开始游戏' }));
            return;
          }
          if (currentRoom.players.length < MIN_PLAYERS) {
            ws.send(JSON.stringify({ type: 'error', message: `至少需要${MIN_PLAYERS}名玩家` }));
            return;
          }
          if (currentRoom.phase !== 'waiting') {
            ws.send(JSON.stringify({ type: 'error', message: '游戏已经在进行中' }));
            return;
          }
          advanceGame(currentRoom);
          break;

        case 'action':
          if (!currentRoom || !currentPlayer) return;
          if (currentRoom.phase === 'waiting') {
            ws.send(JSON.stringify({ type: 'error', message: '游戏还未开始' }));
            return;
          }
          handleAction(currentRoom, currentPlayer, message.action, message.amount);
          break;
      }
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoom && currentPlayer) {
      handleDisconnect(currentRoom, currentPlayer);
    }
  });
});

// HTTP 路由
app.get('/', (req, res) => {
  res.json({
    service: '德州扑克后端服务',
    status: 'running',
    rooms: getAvailableRooms().length
  });
});

app.get('/rooms', (req, res) => {
  res.json(getAvailableRooms());
});