import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

const socket = io(import.meta.env.VITE_SERVER_URL || 'http://localhost:4000', { transports: ['websocket'] });

export default function App() {
  const [devices, setDevices] = useState([]);
  const [latest, setLatest] = useState({});
  const [history, setHistory] = useState({});

  useEffect(() => {
    socket.on('bootstrap', ({ devices, latest, history }) => {
      setDevices(devices);
      setLatest(latest);
      setHistory(history);
    });
    socket.on('status', (msg) => {
      setLatest(prev => ({ ...prev, [msg.id]: { ts: msg.ts, alive: msg.alive, time: msg.time } }));
      setHistory(prev => {
        const arr = [...(prev[msg.id] || []), { ts: msg.ts, alive: msg.alive, time: msg.time }];
        if (arr.length > 500) arr.shift();
        return { ...prev, [msg.id]: arr };
      });
    });
    return () => {
      socket.off('bootstrap'); socket.off('status');
    }
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Network Monitoring Dashboard</h1>
      <p>Live ping every 10s; green = up, red = down.</p>

      <table border="1" cellPadding="6" style={{ borderCollapse: 'collapse', marginBottom: 24 }}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Host</th>
            <th>Status</th>
            <th>Latency (ms)</th>
            <th>Last Check</th>
          </tr>
        </thead>
        <tbody>
          {devices.map(d => {
            const l = latest[d.id];
            const status = l?.alive ? 'UP' : 'DOWN';
            return (
              <tr key={d.id} style={{ background: l?.alive ? '#e7ffe7' : '#ffe7e7' }}>
                <td>{d.name}</td>
                <td>{d.host}</td>
                <td>{status}</td>
                <td>{l?.time ?? '-'}</td>
                <td>{l?.ts ? new Date(l.ts).toLocaleTimeString() : '-'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
