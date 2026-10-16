import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
export default function LatencyChart({ results, intervalMs }) {
  const data = [];
  for (const r of [...results].reverse()) {
    const time = new Date(r.completed_at).getTime();
    const previous = data.at(-1);
    if (previous && time - previous.time > intervalMs * 3)
      data.push({ time: (time + previous.time) / 2, latency_ms: null });
    data.push({ ...r, time });
  }
  return (
    <div
      className="chart"
      aria-label="Latency history in milliseconds; equivalent results listed below"
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={["dataMin", "dataMax"]}
            minTickGap={60}
            tickFormatter={(value) => new Date(value).toLocaleTimeString()}
          />
          <YAxis unit=" ms" width={70} />
          <Tooltip
            labelFormatter={(value) => new Date(value).toLocaleString()}
          />
          <Line
            type="linear"
            dataKey="latency_ms"
            name="Latency (ms)"
            stroke="#5369e8"
            dot={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
