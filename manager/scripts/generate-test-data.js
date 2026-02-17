#!/usr/bin/env node
/**
 * Generate Test Data for Analytics
 * Creates realistic session history data for testing admin panel analytics
 *
 * Usage:
 *   node scripts/generate-test-data.js --count=500 --days=90
 *
 * Options:
 *   --count=N     Number of sessions to generate (default: 500)
 *   --days=N      Number of days to spread sessions over (default: 90)
 *   --db=PATH     Database path (default: data/app.db)
 *   --clear       Clear existing session history before generating
 */

const path = require('path');
const { initializeDb, getDb } = require('../lib/db');

// Parse command line arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  acc[key] = value === undefined ? true : value;
  return acc;
}, {});

const COUNT = parseInt(args.count || '500', 10);
const DAYS = parseInt(args.days || '90', 10);
const DB_PATH = args.db || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'test_app.db');
const CLEAR = args.clear || false;

// Realistic distributions
const USERS = [
  'domeally', 'jsmith', 'azhang', 'mgarcia', 'lchen', 'rjohnson',
  'kpatel', 'swilliams', 'tbrown', 'jlee', 'mmiller', 'cdavis',
  'nthompson', 'pjackson', 'hwhite', 'oharris', 'fmartin', 'brobinson'
];

const ACCOUNTS = ['jkaddis', 'jpatel', 'msmith', 'research', 'training'];

const CLUSTERS = ['gemini', 'apollo'];

const IDES = [
  { name: 'vscode', weight: 0.60 },
  { name: 'rstudio', weight: 0.30 },
  { name: 'jupyter', weight: 0.10 }
];

const RELEASES = [
  { version: '3.22', weight: 0.40 },
  { version: '3.21', weight: 0.30 },
  { version: '3.20', weight: 0.15 },
  { version: '3.19', weight: 0.10 },
  { version: '3.18', weight: 0.05 }
];

const GPUS = [
  { type: null, weight: 0.80 },
  { type: 'a100', weight: 0.15 },
  { type: 'v100', weight: 0.05 }
];

const CPU_DISTRIBUTION = [
  { cpus: 1, weight: 0.10 },
  { cpus: 2, weight: 0.20 },
  { cpus: 4, weight: 0.30 },
  { cpus: 8, weight: 0.20 },
  { cpus: 16, weight: 0.12 },
  { cpus: 32, weight: 0.05 },
  { cpus: 64, weight: 0.03 }
];

const WALLTIME_DISTRIBUTION = [
  { hours: 1, weight: 0.10 },
  { hours: 2, weight: 0.15 },
  { hours: 4, weight: 0.25 },
  { hours: 8, weight: 0.20 },
  { hours: 12, weight: 0.15 },
  { hours: 24, weight: 0.10 },
  { hours: 48, weight: 0.05 }
];

const END_REASONS = [
  { reason: 'completed', weight: 0.70 },
  { reason: 'cancelled', weight: 0.20 },
  { reason: 'timeout', weight: 0.07 },
  { reason: 'error', weight: 0.03 }
];

// Utility functions
function weightedRandom(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let rand = Math.random() * total;
  for (const item of items) {
    rand -= item.weight;
    if (rand <= 0) return item;
  }
  return items[items.length - 1];
}

function randomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatWalltime(hours) {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:00`;
}

function formatMemory(cpus) {
  // Memory typically scales with CPUs: 8-16GB per CPU
  const gbPerCpu = randomInt(8, 16);
  return `${cpus * gbPerCpu}G`;
}

function generateSession(dayOffset) {
  const user = randomElement(USERS);
  const account = randomElement(ACCOUNTS);
  const hpc = randomElement(CLUSTERS);
  const ide = weightedRandom(IDES).name;
  const release = weightedRandom(RELEASES).version;
  const gpu = weightedRandom(GPUS).type;
  const cpusItem = weightedRandom(CPU_DISTRIBUTION);
  const cpus = cpusItem.cpus;
  const memory = formatMemory(cpus);
  const walltimeItem = weightedRandom(WALLTIME_DISTRIBUTION);
  const walltime = formatWalltime(walltimeItem.hours);
  const endReasonItem = weightedRandom(END_REASONS);
  const endReason = endReasonItem.reason;

  // Time calculations
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const minMs = 60 * 1000;

  // Random time within the day (bias towards work hours)
  const workHourBias = Math.random() < 0.7;
  const hourOfDay = workHourBias ? randomInt(8, 18) : randomInt(0, 23);
  const minuteOfDay = randomInt(0, 59);

  const submittedAt = new Date(now - (dayOffset * dayMs) + (hourOfDay * hourMs) + (minuteOfDay * minMs));

  // Wait time (queue time) - typically 30s to 15min, occasionally longer
  const waitSeconds = Math.random() < 0.85
    ? randomInt(30, 900)  // 30s to 15min
    : randomInt(900, 3600); // 15min to 1hr for busy times

  const startedAt = new Date(submittedAt.getTime() + (waitSeconds * 1000));

  // Duration - typically fraction of walltime, but can hit limit
  let durationMinutes;
  if (endReason === 'timeout') {
    durationMinutes = walltimeItem.hours * 60;
  } else if (endReason === 'error') {
    durationMinutes = randomInt(1, 30);
  } else if (endReason === 'cancelled') {
    durationMinutes = randomInt(1, walltimeItem.hours * 30);
  } else {
    // Completed - typically 30-90% of walltime
    const usedFraction = 0.3 + (Math.random() * 0.6);
    durationMinutes = Math.round(walltimeItem.hours * 60 * usedFraction);
  }

  const endedAt = new Date(startedAt.getTime() + (durationMinutes * minMs));

  // Dev server usage (only for VS Code, ~25%)
  const usedDevServer = ide === 'vscode' && Math.random() < 0.25 ? 1 : 0;

  // Error message for failed sessions
  const errorMessage = endReason === 'error'
    ? randomElement([
        'OOM killer terminated process',
        'Connection timeout to compute node',
        'Disk quota exceeded',
        'Module load failed: R/4.3.0',
      ])
    : null;

  return {
    user,
    hpc,
    ide,
    account,
    cpus,
    memory,
    walltime,
    gpu,
    release_version: release,
    submitted_at: submittedAt.toISOString(),
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    wait_seconds: waitSeconds,
    duration_minutes: durationMinutes,
    end_reason: endReason,
    error_message: errorMessage,
    used_dev_server: usedDevServer,
    job_id: `${randomInt(10000, 99999)}`,
    node: `node-${randomInt(1, 200).toString().padStart(3, '0')}`
  };
}

function generateClusterHealth(dayOffset) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // Generate 24 snapshots per day (one per hour)
  const snapshots = [];

  for (let hour = 0; hour < 24; hour++) {
    // Utilization varies by time of day
    const isWorkHours = hour >= 8 && hour <= 18;
    const baseUtil = isWorkHours ? randomInt(50, 90) : randomInt(20, 50);

    for (const hpc of CLUSTERS) {
      const timestamp = now - (dayOffset * dayMs) + (hour * 60 * 60 * 1000);
      snapshots.push({
        hpc,
        timestamp,
        cpus_percent: baseUtil + randomInt(-10, 10),
        memory_percent: baseUtil + randomInt(-15, 15),
        nodes_percent: Math.max(20, baseUtil + randomInt(-20, 10)),
        gpus_percent: hpc === 'gemini' ? baseUtil + randomInt(-5, 20) : null,
        running_jobs: Math.floor(baseUtil / 5) + randomInt(0, 10),
        pending_jobs: isWorkHours ? randomInt(0, 30) : randomInt(0, 5)
      });
    }
  }

  return snapshots;
}

// Main execution
async function main() {
  console.log(`Generating test data: ${COUNT} sessions over ${DAYS} days`);
  console.log(`Database: ${DB_PATH}`);

  // Initialize database
  initializeDb(DB_PATH);
  const db = getDb();

  // Optionally clear existing data
  if (CLEAR) {
    console.log('Clearing existing session history...');
    db.prepare('DELETE FROM session_history').run();
    db.prepare('DELETE FROM cluster_health').run();
  }

  // Generate sessions
  console.log('Generating sessions...');
  const insertSession = db.prepare(`
    INSERT INTO session_history (
      user, hpc, ide, account, cpus, memory, walltime, gpu,
      release_version, submitted_at, started_at, ended_at,
      wait_seconds, duration_minutes, end_reason, error_message,
      used_dev_server, job_id, node
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const sessionTransaction = db.transaction(() => {
    for (let i = 0; i < COUNT; i++) {
      const dayOffset = Math.floor(Math.random() * DAYS);
      const session = generateSession(dayOffset);

      insertSession.run(
        session.user,
        session.hpc,
        session.ide,
        session.account,
        session.cpus,
        session.memory,
        session.walltime,
        session.gpu,
        session.release_version,
        session.submitted_at,
        session.started_at,
        session.ended_at,
        session.wait_seconds,
        session.duration_minutes,
        session.end_reason,
        session.error_message,
        session.used_dev_server,
        session.job_id,
        session.node
      );

      if ((i + 1) % 100 === 0) {
        process.stdout.write(`\r  Sessions: ${i + 1}/${COUNT}`);
      }
    }
  });

  sessionTransaction();
  console.log(`\n  Generated ${COUNT} sessions`);

  // Generate cluster health history
  console.log('Generating cluster health history...');
  const insertHealth = db.prepare(`
    INSERT INTO cluster_health (
      hpc, timestamp, cpus_percent, memory_percent, nodes_percent,
      gpus_percent, running_jobs, pending_jobs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const healthTransaction = db.transaction(() => {
    let healthCount = 0;
    for (let day = 0; day < DAYS; day++) {
      const snapshots = generateClusterHealth(day);
      for (const snapshot of snapshots) {
        insertHealth.run(
          snapshot.hpc,
          snapshot.timestamp,
          snapshot.cpus_percent,
          snapshot.memory_percent,
          snapshot.nodes_percent,
          snapshot.gpus_percent,
          snapshot.running_jobs,
          snapshot.pending_jobs
        );
        healthCount++;
      }

      if ((day + 1) % 10 === 0) {
        process.stdout.write(`\r  Health snapshots: day ${day + 1}/${DAYS}`);
      }
    }
    return healthCount;
  });

  const healthCount = healthTransaction();
  console.log(`\n  Generated ${healthCount} health snapshots`);

  // Generate some test users if needed
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    console.log('Generating test users...');
    const insertUser = db.prepare(`
      INSERT OR IGNORE INTO users (
        username, full_name, public_key, setup_complete, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const userTransaction = db.transaction(() => {
      const fullNames = {
        'domeally': 'Denis O\'Mealy',
        'jsmith': 'Jane Smith',
        'azhang': 'Alice Zhang',
        'mgarcia': 'Maria Garcia',
        'lchen': 'Li Chen',
        'rjohnson': 'Robert Johnson'
      };

      for (const username of USERS.slice(0, 6)) {
        insertUser.run(
          username,
          fullNames[username] || username,
          'ssh-ed25519 AAAA... test-key',
          1,
          new Date(Date.now() - randomInt(30, 365) * 24 * 60 * 60 * 1000).toISOString()
        );
      }
    });

    userTransaction();
    console.log(`  Generated ${USERS.slice(0, 6).length} test users`);
  }

  // Summary
  console.log('\nSummary:');
  const sessionCount = db.prepare('SELECT COUNT(*) as count FROM session_history').get().count;
  const healthSnapshots = db.prepare('SELECT COUNT(*) as count FROM cluster_health').get().count;
  const users = db.prepare('SELECT COUNT(*) as count FROM users').get().count;

  console.log(`  Sessions: ${sessionCount}`);
  console.log(`  Health snapshots: ${healthSnapshots}`);
  console.log(`  Users: ${users}`);
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
