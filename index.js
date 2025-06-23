// whatsapp-multiclient-api/index.js

const express = require('express');
const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const WebSocket = require('ws');
const knex = require('./helper/db'); // import instance knex

const cors = require('cors');


const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const sendQueue = [];
const sendQueueClients = {};

app.use(express.json());
const allowedOrigins = ['https://dashboard.importpartner.id', 'http://localhost:4000'];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));


const sessions = {};
const qrCodes = {};
const broadcastQueue = {};
const qrSocketClients = {}; // { sessionId: [ws, ws, ...] }
const sessionSaved = {}; // sessionId: true kalau sudah diinsert


function createClient(sessionId) {
  if (sessions[sessionId]) return sessions[sessionId];

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: { headless: true, args: ['--no-sandbox'] }
  });

  client.on('qr', qr => {
    // Jangan kirim QR kalau user sudah login
    if (qrCodes[sessionId] === null) return;

    console.log(`[${sessionId}] QR code generated`);
    qrcode.toDataURL(qr, (err, url) => {
      if (!err) {
        qrCodes[sessionId] = url;
        const sockets = qrSocketClients[sessionId] || [];
        sockets.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'qr', data: url }));
          }
        });
      }
    });
  });

  client.on('authenticated', async () => {
    console.log(`[${sessionId}] authenticated`);

    qrCodes[sessionId] = null;
  });

  client.on('ready', async () => {
    // ✅ Cek & Simpan ke DB satu kali
    if (!sessionSaved[sessionId]) {
      const number = client.info?.wid?.user;
      if (number) {
        try {
          await knex('wa_sessions')
            .insert({ session_id: sessionId, number })
            .onConflict('session_id')
            .merge();

          sessionSaved[sessionId] = true;
          console.log(`[${sessionId}] saved to DB: ${number}`);
        } catch (err) {
          console.error(`[${sessionId}] DB error`, err);
        }
      }

      qrCodes[sessionId] = null;
      const sockets = qrSocketClients[sessionId] || [];
      sockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'done' }));
        }
      });
    }
    console.log("sending message")
    // ✅ Tetap proses sendQueue meskipun session sudah disimpan
    const queued = sendQueue[sessionId] || [];
    for (const item of queued) {
      const recipient = `${item.to}@c.us`;
      let status = 'sent';
      console.log(`Start process to Send message to ${recipient}`)
      try {
        if (item.type === 'text') {
          await client.sendMessage(recipient, item.message);
        } else if (item.type === 'image') {
          const media = await MessageMedia.fromUrl(item.url);
          await client.sendMessage(recipient, media, { caption: item.caption });
        } else if (item.type === 'button') {
          const btn = new Buttons(item.message, [{ body: 'Click Here' }], 'Title', 'Footer');
          await client.sendMessage(recipient, btn);
        }

      } catch (err) {
        console.error(`❌ Failed to send to ${recipient}:`, err);
        status = 'failed';
      }

      const sockets = qrSocketClients[sessionId] || [];
      sockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'send-result', to: item.to, status }));
        }
      });
    }

    sendQueue[sessionId] = [];
  });



  client.on('disconnected', () => {
    delete sessions[sessionId];
    delete qrCodes[sessionId];
    delete qrSocketClients[sessionId];
    console.log(`[${sessionId}] disconnected`);
  });

  client.initialize();
  sessions[sessionId] = client;
  return client;
}

async function processSendQueue(sessionId) {
  const client = sessions[sessionId];
  if (!client || !client.info?.wid) return; // pastikan client ready

  const queued = sendQueue[sessionId] || [];
  for (const item of queued) {
    const recipient = `${item.to}@c.us`;
    let status = 'sent';

    try {
      if (item.type === 'text') {
        await client.sendMessage(recipient, item.message);
      } else if (item.type === 'image') {
        const media = await MessageMedia.fromUrl(item.url);
        await client.sendMessage(recipient, media, { caption: item.caption });
      } else if (item.type === 'button') {
        const btn = new Buttons(item.message, [{ body: 'Click Here' }], 'Title', 'Footer');
        await client.sendMessage(recipient, btn);
      }
    } catch (err) {
      console.error(`❌ Failed to send to ${recipient}:`, err);
      status = 'failed';
    }

    const sockets = qrSocketClients[sessionId] || [];
    sockets.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'send-result', to: item.to, status }));
      }
    });
  }

  sendQueue[sessionId] = []; // kosongkan queue
}


function waitForClientReady(client) {

  return new Promise((resolve) => {
    if (client.isReady) {
      return resolve();
    }
    client.once('ready', () => {
      client.isReady = true;
      resolve();
    });
  });
}

// WebSocket endpoint
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace('/?', ''));

  const sessionId = params.get('id');
  const actionId = params.get('action') ?? "";

  if (!qrSocketClients[sessionId]) qrSocketClients[sessionId] = [];
  qrSocketClients[sessionId].push(ws);

  if (!sendQueueClients[sessionId]) sendQueueClients[sessionId] = [];
  sendQueueClients[sessionId].push(ws);


  // cleanup when socket closes
  ws.on('close', () => {
    qrSocketClients[sessionId] = qrSocketClients[sessionId]?.filter(s => s !== ws);
    if (qrSocketClients[sessionId] && qrSocketClients[sessionId].length === 0) delete qrSocketClients[sessionId];

    sendQueueClients[sessionId] = sendQueueClients[sessionId]?.filter(s => s !== ws);
    if (sendQueueClients[sessionId] && sendQueueClients[sessionId].length === 0) delete sendQueueClients[sessionId];
  });
});

// 1. Check session or return QR (JSON or HTML)
app.get('/session/:id/:expect', (req, res) => {
  try {
    const { id, expect } = req.params;
    const client = createClient(id);

    if (client.info?.wid) {
      return res.json({ status: 'authenticated' });
    }

    const qr = qrCodes[id];
    if (qr) {
      if (expect === 'html') {
        return res.send(`<html><body><img src="${qr}" style="width:300px;height:300px"/></body></html>`);
      } else {
        return res.json({ status: 'pending', qr });
      }
    }

    res.json({ status: 'initializing' });
  } catch (error) {
    console.log({ error })
  }
});

// 2. Destroy session
app.delete('/session/:id', async (req, res) => {
  const { id } = req.params;
  const client = sessions[id];
  if (client) {
    await client.destroy();
    delete sessions[id];
    delete qrCodes[id];
    delete qrSocketClients[id];
    res.json({ status: 'destroyed' });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// 3. Send message
app.post('/send/:id', async (req, res) => {
  const { id } = req.params;
  console.log(req.body)
  let type = req.body?.type ?? "";

  let to = req.body.to ?? 0;
  let message = req.body.message ?? "";
  let url = req.body.url ?? null;
  let filename = req.body.filename ?? null;
  let caption = req.body.caption ?? null;




  const client = createClient(id); // trigger init kalau belum ada
  if (!client) return res.status(404).json({ error: 'Session not found' });

  const payload = { to, type, message, url, filename, caption };

  // Simpan ke queue
  if (!sendQueue[id]) sendQueue[id] = [];
  sendQueue[id].push(payload);

  res.json({ status: 'queued' });

  // 🚀 Proses langsung jika sudah ready
  if (client.info?.wid) {
    await processSendQueue(id);
  }
});


// 4. Broadcast queue
app.post('/broadcast/:id', (req, res) => {
  const { id } = req.params;
  const { numbers, message } = req.body;
  const client = sessions[id];

  if (!client) return res.status(404).json({ error: 'Session not found' });

  broadcastQueue[id] = [...(broadcastQueue[id] || []), ...numbers];

  const processQueue = async () => {
    if (!broadcastQueue[id] || broadcastQueue[id].length === 0) return;

    const num = broadcastQueue[id].shift();
    try {
      await client.sendMessage(num, message);
      console.log(`Sent to ${num}`);
    } catch (e) {
      console.log(`Failed to send to ${num}: ${e.message}`);
    }

    setTimeout(processQueue, 2000); // 2s delay to reduce risk
  };

  processQueue();
  res.json({ status: 'queued', total: numbers.length });
});

server.listen(3000, () => console.log('API + WS ready on http://localhost:3000'));
