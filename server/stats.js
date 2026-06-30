// Host CPU + memory snapshot for the header gauge / popdown. CPU is sampled
// per-core over a short window so each call is self-contained. Memory is
// cache-aware (MemAvailable) and also reports cache so the bar can show it.
import os from 'node:os';
import { readFileSync } from 'node:fs';

function coreTimes() {
  return os.cpus().map((c) => {
    let total = 0;
    for (const v of Object.values(c.times)) total += v;
    return { idle: c.times.idle, total };
  });
}

function samplePerCore(ms = 250) {
  return new Promise((resolve) => {
    const a = coreTimes();
    setTimeout(() => {
      const b = coreTimes();
      resolve(a.map((x, i) => {
        const idle = b[i].idle - x.idle;
        const total = b[i].total - x.total;
        return total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : 0;
      }));
    }, ms);
  });
}

function memInfo() {
  let total = os.totalmem(), avail = os.freemem(), cached = 0;
  try {
    const mi = readFileSync('/proc/meminfo', 'utf8');
    const g = (re) => { const m = re.exec(mi); return m ? parseInt(m[1], 10) * 1024 : 0; };
    total = g(/MemTotal:\s+(\d+) kB/) || total;
    avail = g(/MemAvailable:\s+(\d+) kB/) || avail;
    cached = g(/^Cached:\s+(\d+) kB/m) + g(/^Buffers:\s+(\d+) kB/m);
  } catch {}
  const used = total - avail;
  const gb = (n) => +(n / 1e9).toFixed(1);
  return {
    percent: Math.round((used / total) * 100),
    usedGb: gb(used), availGb: gb(avail), cachedGb: gb(cached), totalGb: gb(total)
  };
}

export async function getStats() {
  const cores = await samplePerCore();
  const cpu = Math.round(cores.reduce((a, b) => a + b, 0) / cores.length);
  return { cpu, cores, mem: memInfo() };
}
