var fs = require('fs');
var path = require("path");\nvar https = require('https');
var express = require('express');
var app = express();

var faye = require('faye');
var WebSocketServer = require('faye-websocket');

// ========================================
// SSL CERTIFICATE AUTO-RELOAD
// ========================================
const sslDir = '/home/admin/conf/web/api.pharoscms.com/ssl';
const certPath = path.join(sslDir, 'api.pharoscms.com.crt');
const keyPath = path.join(sslDir, 'api.pharoscms.com.key');
const caPath = path.join(sslDir, 'api.pharoscms.com.ca');

let certMtime = 0;
let keyMtime = 0;

function loadCerts() {
  try {
    const certStat = fs.statSync(certPath);
    const keyStat = fs.statSync(keyPath);

    if (certStat.mtimeMs > certMtime || keyStat.mtimeMs > keyMtime) {
      console.log('[SSL] Reloading certificates...');
      certMtime = certStat.mtimeMs;
      keyMtime = keyStat.mtimeMs;

      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
        ca: fs.readFileSync(caPath)
      };
    }
  } catch (err) {
    console.error('[SSL] Failed to read certs:', err.message);
  }

  return null;
}

// Initial load
let httpsOptions = loadCerts();
if (!httpsOptions) {
  console.error('[FATAL] Could not load initial SSL certificates. Exiting.');
  process.exit(1);
}

function getHttpsOptions() {
  const fresh = loadCerts();
  return fresh || httpsOptions;
}

// ========================================
// CHAT WEBSOCKET DATA STRUCTURES
// ========================================

var chatRooms = {};
var chatClients = new WeakMap();
var messageHistory = {};
var MAX_HISTORY = 100;

// ========================================
// CHAT HELPER FUNCTIONS
// ========================================

function addToChatRoom(roomId, ws) {
  if (!chatRooms[roomId]) {
    chatRooms[roomId] = new Set();
  }
  chatRooms[roomId].add(ws);
  console.log(`[Chat] Client added to room ${roomId}. Total: ${chatRooms[roomId].size}`);
}

function removeFromChatRoom(roomId, ws) {
  if (chatRooms[roomId]) {
    chatRooms[roomId].delete(ws);
    if (chatRooms[roomId].size === 0) {
      delete chatRooms[roomId];
    }
  }
}

function broadcastToChatRoom(roomId, message, excludeWs = null) {
  if (!chatRooms[roomId]) return;

  const messageStr = JSON.stringify(message);

  chatRooms[roomId].forEach(client => {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(messageStr);
    }
  });
}

function saveChatMessage(roomId, message) {
  if (!messageHistory[roomId]) {
    messageHistory[roomId] = [];
  }

  messageHistory[roomId].push(message);

  if (messageHistory[roomId].length > MAX_HISTORY) {
    messageHistory[roomId].shift();
  }
}

function getChatHistory(roomId, limit = 50) {
  if (!messageHistory[roomId]) return [];

  const history = messageHistory[roomId];
  const start = Math.max(0, history.length - limit);
  return history.slice(start);
}

// ========================================
// WEBSOCKET CHAT HANDLER
// ========================================

var server = https.createServer({
  SNICallback: (servername, cb) => {
    // Re-read certs on every TLS handshake (SNI)
    const opts = getHttpsOptions();
    cb(null, opts);
  },
  ...getHttpsOptions()
}, app);

var bayeux = new faye.NodeAdapter({mount: '/faye', timeout: 45});

server.on('upgrade', function(request, socket, body) {
  // Log for debugging
  console.log('Upgrade request for:', request.url);

  // Handle your custom Chat WebSocket
  if (WebSocketServer.isWebSocket(request)) {

    if (request.url === '/chat') {
      var ws = new WebSocketServer(request, socket, body);
      handleChatConnection(ws);
      return;
    }

    // Handle Faye's internal WebSocket needs
    if (bayeux.handleUpgrade) {
      bayeux.handleUpgrade(request, socket, body);
      return;
    }
  }
});

function handleChatConnection(ws) {
  console.log('[Chat] New WebSocket connection');

  ws.on('message', async function(event) {
    try {
      const message = JSON.parse(event.data);
      console.log('[Chat] Received:', message.action);

      // Handle send_message
      if (message.action === 'send_message') {
        const prospectKey = message.room;

        const senderId = message.user_id || '';

        const messageData = {
          id: Date.now().toString() + Math.random(),
          text: message.text,
          sender: message.sender,
          sender_id: message.user_id,
          timestamp: message.timestamp || new Date().toISOString()
        };

        console.log(`[Chat] Saving message for prospect ${prospectKey}`);

        saveChatMessage(prospectKey, messageData);

        broadcastToChatRoom(prospectKey, {
          type: 'message',
          ...messageData
        });

        console.log(`[Chat] Message broadcasted to room ${prospectKey}`);
      }

    } catch (error) {
      console.error('[Chat] Error:', error);
    }
  });

  ws.on('close', function(event) {
    const clientInfo = chatClients.get(ws);
    if (clientInfo) {
      removeFromChatRoom(clientInfo.roomId, ws);
    }
    console.log('[Chat] Client disconnected');
  });

  ws.on('error', function(error) {
    console.error('[Chat] WebSocket error:', error);
  });
}

// ========================================
// HTTP API ENDPOINTS FOR CHAT
// ========================================

app.use(express.json());

// Check if users are connected to a chat room
app.get('/api/check-room/:room_id', function(req, res) {
  const roomId = req.params.room_id;
  const isConnected = chatRooms[roomId] && chatRooms[roomId].size > 0;
  const userCount = chatRooms[roomId] ? chatRooms[roomId].size : 0;

  res.json({
    room_id: roomId,
    connected: isConnected,
    user_count: userCount
  });
});

// Broadcast message to chat room (from PHP - after DB save)
app.post('/api/send-message', function(req, res) {
  try {
    const { prospect_key, text, sender, sender_id, timestamp, message_id } = req.body;

    if (!prospect_key || !text || !sender_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: prospect_key, text, sender_id'
      });
    }

    const messageData = {
      id: message_id || (Date.now().toString() + Math.random()),
      text: text,
      sender: sender || 'User',
      sender_id: sender_id,
      timestamp: timestamp || new Date().toISOString()
    };

    saveChatMessage(prospect_key, messageData);

    broadcastToChatRoom(prospect_key, {
      type: 'message',
      ...messageData
    });

    console.log(`[Chat API] Message broadcasted to room ${prospect_key}`);

    res.json({ success: true, message_id: messageData.id });

  } catch (error) {
    console.error('[Chat API] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    chat_rooms: Object.keys(chatRooms).length,
    total_chat_clients: Object.values(chatRooms).reduce((sum, room) => sum + room.size, 0)
  });
});

bayeux.addExtension({
  incoming: function(message, callback) {
    console.log(Date.now(), "incoming", message);
    callback(message);
  },
  outgoing: function(message, callback) {
    callback(message);
  }
});

bayeux.on('handshake', function(clientId) {
  console.log('[Faye] Client connected:', clientId);
});

bayeux.on('disconnect', function(clientId) {
  console.log('[Faye] Client disconnected:', clientId);
});

bayeux.on('subscribe', function(clientId, channel) {
  console.log('[Faye] Client', clientId, 'subscribed to', channel);
});

bayeux.on('publish', function(clientId, channel, data) {
  console.log('[Faye] Publish to', channel, ':', JSON.stringify(data).substring(0, 100));

  // Relay Faye messages to the custom WebSocket chat system
  if (channel.startsWith('/cases/') && channel.endsWith('/messages')) {
    const parts = channel.split('/');
    const roomId = parts[2]; // Extract {caseId} from /cases/{caseId}/messages

    if (data && data.message) {
      const msg = data.message;
      const messageData = {
        id: msg.message_id || (Date.now().toString() + Math.random()),
        text: msg.text || msg.message_text || msg.message || '',
        sender: (msg.sender && msg.sender.name) ? msg.sender.name : (msg.sender_name || msg.sender_type || 'System'),
        sender_id: (msg.sender && msg.sender.user_id) ? msg.sender.user_id : (msg.sender_id || ''),
        timestamp: msg.created_at || new Date().toISOString(),
        message_type: msg.message_type || 'text',
        image_url: msg.image_url || null,
        thumbnail_url: msg.thumbnail_url || null
      };

      console.log(`[Faye Relay] Relaying message for room ${roomId}`);

      saveChatMessage(roomId, messageData);

      broadcastToChatRoom(roomId, {
        type: 'message',
        ...messageData
      });
    }
  }
});

// ========================================
// START SERVER
// ========================================

bayeux.attach(server);
server.listen(2096, function() {
  console.log('========================================');
  console.log('Faye Server: https://api.pharoscms.com:2096/');
  console.log('Chat WebSocket: wss://api.pharoscms.com:2096/chat');
  console.log('Chat API: https://api.pharoscms.com:2096/api/');
  console.log('========================================');
});
