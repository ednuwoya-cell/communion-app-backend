// ═══════════════════════════════════════════════════════════════
//  GIC Communion — Backend Server
//  Node.js + Express + Web Push (VAPID)
//  Deploy this to Render.com (free tier)
// ═══════════════════════════════════════════════════════════════
const express   = require('express');
const cors      = require('cors');
const webpush   = require('web-push');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── VAPID config (Web Push) ───────────────────────────────────
// These keys are set as environment variables on Render.com
// Generate your own with: npx web-push generate-vapid-keys
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BB6OgY3wyQj7_nRQsllvKxYg-l6WByqtkSQN1g0G60X6uE1aH-G54vEylvApqnsuQtyni-eReNEFdpX5qp3G9fM';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'uE1aH-G54vEylvApqnsuQtyni-eReNEFdpX5qp3G9fM';
const VAPID_EMAIL   = process.env.VAPID_EMAIL       || 'mailto:admin@globalimpactchurch.org';
const ADMIN_PIN     = process.env.ADMIN_PIN         || 'gic2026';

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// ── In-memory store ───────────────────────────────────────────
// Production: replace with a free MongoDB Atlas cluster
const store = {
  subscriptions: {},   // { id: { subscription, name, registeredAt } }
  assignments:   {},   // { position: [{name,item},...] }
  serviceDate:   '',
  confirmations: [],   // [ { name, position, item, time } ]
};

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Auth ──────────────────────────────────────────────────────
function adminOnly(req, res, next) {
  if (req.headers['x-admin-pin'] !== ADMIN_PIN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// Health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'GIC Communion Backend',
    subscribers: Object.keys(store.subscriptions).length,
    vapidPublic: VAPID_PUBLIC,
  });
});

// Return VAPID public key (needed by PWA to subscribe)
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Minister registers their push subscription
// POST /subscribe  { name, subscription }
app.post('/subscribe', (req, res) => {
  const { name, subscription } = req.body;
  if (!name || !subscription?.endpoint) {
    return res.status(400).json({ ok: false, error: 'name and subscription required' });
  }
  const id = Buffer.from(subscription.endpoint).toString('base64').slice(-24);
  store.subscriptions[id] = {
    id, name: name.trim(), subscription,
    registeredAt: new Date().toISOString(),
  };
  console.log(`📱 Subscribed: ${name}`);
  res.json({ ok: true, id });
});

// Get registered subscribers (admin)
app.get('/admin/subscribers', adminOnly, (req, res) => {
  const list = Object.values(store.subscriptions).map(s => ({
    id: s.id, name: s.name, registeredAt: s.registeredAt
  }));
  res.json({ ok: true, count: list.length, subscribers: list });
});

// Save assignments (admin)
app.post('/admin/assignments', adminOnly, (req, res) => {
  const { serviceDate, assignments } = req.body;
  if (!assignments) return res.status(400).json({ ok: false, error: 'assignments required' });
  store.assignments = assignments;
  store.serviceDate = serviceDate || store.serviceDate;
  store.confirmations = []; // Reset for new service
  console.log(`📋 Assignments saved: ${serviceDate}`);
  res.json({ ok: true });
});

// Get current assignments
app.get('/assignments', (req, res) => {
  res.json({ ok: true, serviceDate: store.serviceDate, assignments: store.assignments });
});

// BROADCAST — push to every registered device
app.post('/admin/broadcast', adminOnly, async (req, res) => {
  const { serviceDate, assignments } = req.body;
  if (assignments) { store.assignments = assignments; store.serviceDate = serviceDate || store.serviceDate; }

  const subs = Object.values(store.subscriptions);
  if (!subs.length) return res.status(400).json({ ok: false, error: 'No registered devices yet. Ministers must open the app and register first.' });
  if (!Object.keys(store.assignments).length) return res.status(400).json({ ok: false, error: 'No assignments saved.' });

  let sent = 0, failed = 0, unassigned = 0;
  const stale = []; // expired subscriptions to remove

  await Promise.all(subs.map(async ({ id, name, subscription }) => {
    // Find this minister's assignment
    let found = null;
    for (const [pos, slots] of Object.entries(store.assignments)) {
      for (const slot of slots) {
        if (slot.name && slot.name.toLowerCase().includes(name.toLowerCase())) {
          found = { position: pos, item: slot.item, name: slot.name };
          break;
        }
      }
      if (found) break;
    }

    if (!found) { unassigned++; return; }

    const itemIcon = found.item === 'Bread' ? '🍞' : found.item === 'Wine' ? '🍷' : '🥣';
    const payload = JSON.stringify({
      title: `${name.split(' ')[0]}, Your Assignment Is Ready`,
      body: `${found.position} · ${found.item} ${itemIcon}`,
      data: {
        ministerName: found.name,
        position: found.position,
        item: found.item,
        serviceDate: store.serviceDate,
      }
    });

    try {
      await webpush.sendNotification(subscription, payload, {
        urgency: 'high',
        TTL: 86400, // deliver within 24 hours even if phone is off
      });
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) stale.push(id); // unsubscribed
      failed++;
      console.error(`❌ Push failed for ${name}:`, err.message);
    }
  }));

  stale.forEach(id => delete store.subscriptions[id]);

  console.log(`📡 Broadcast: ${sent} sent, ${failed} failed, ${unassigned} unassigned`);
  res.json({ ok: true, sent, failed, unassigned });
});

// Minister confirms receipt
app.post('/confirm', (req, res) => {
  const { name, position, item } = req.body;
  if (!name || !position) return res.status(400).json({ ok: false, error: 'name and position required' });

  const already = store.confirmations.find(c => c.name.toLowerCase() === name.toLowerCase() && c.position === position);
  if (already) return res.json({ ok: true, alreadyConfirmed: true });

  const conf = { name, position, item, time: new Date().toISOString() };
  store.confirmations.push(conf);
  console.log(`✅ Confirmed: ${name} — ${position}`);
  res.json({ ok: true, confirmation: conf });
});

// Get confirmations (admin)
app.get('/admin/confirmations', adminOnly, (req, res) => {
  res.json({
    ok: true,
    count: store.confirmations.length,
    confirmations: [...store.confirmations].reverse(),
  });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 GIC Communion Backend running on :${PORT}`);
  console.log(`🔑 VAPID public key: ${VAPID_PUBLIC.slice(0, 20)}…`);
  console.log(`🔐 Admin PIN: ${ADMIN_PIN}\n`);
});
