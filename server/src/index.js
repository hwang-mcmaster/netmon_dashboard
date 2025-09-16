import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import url from 'url';
import * as ping from 'ping';
import cron from 'node-cron';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const DEVICES_PATH = path.join(__dirname, '..', 'devices.json');
let devices = JSON.parse(fs.readFileSync(DEVICES_PATH, 'utf-8'));
let history = {}; // {id: [{ts, alive, time} ...]}
let latest = {};  // {id: {alive, time, ts}}

function saveDevices() {
  fs.writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2));
}

async function checkDevice(device) {
  try {
    const res = await ping.promise.probe(device.host, { timeout: 2, extra: ['-c', '1'] });
    const item = { ts: Date.now(), alive: res.alive, time: res.time ? Number(res.time) : null };
    latest[device.id] = item;
    if (!history[device.id]) history[device.id] = [];
    history[device.id].push(item);
    if (history[device.id].length > 500) history[device.id].shift();
    io.emit('status', { id: device.id, ...item });
  } catch (e) {
    const item = { ts: Date.now(), alive: false, time: null };
    latest[device.id] = item;
    if (!history[device.id]) history[device.id] = [];
    history[device.id].push(item);
    io.emit('status', { id: device.id, ...item });
  }
}

async function pollAll() {
  await Promise.all(devices.filter(d=>d.enabled).map(checkDevice));
}

io.on('connection', (socket) => {
  socket.emit('bootstrap', { devices, latest, history });
});

app.get('/api/devices', (req, res) => res.json(devices));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log('NetMon server listening on port', PORT);
});

cron.schedule('*/10 * * * * *', pollAll);
pollAll();
