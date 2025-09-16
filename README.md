# Network Monitoring Dashboard (NetMon)
It’s a simple network monitoring tool you can run locally.
Define a list of devices/hosts to monitor in server/devices.json, and Every 10 seconds, the backend automatically pings each host to check if it’s up or down, and measures its latency. The results are streamed live to the frontend dashboard

- Server: Node.js + Express + Socket.IO
- Client: React + Vite + Recharts


Green = device is reachable
Red = unreachable
Charts = latency trend


## Quick Start
### Server
```bash
cd server
npm install
npm run dev
```
### Client
```bash
cd client
npm install
cp .env.example .env
npm run dev
```
