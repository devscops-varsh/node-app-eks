const express = require('express');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;

// This env var is used later to intentionally simulate a failure
// (bad env var -> app fails to construct redis connection string)
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT || '6379';

if (!REDIS_HOST) {
  // Fail fast and loudly instead of hanging — makes the CrashLoopBackOff
  // debugging story clean: `kubectl logs` immediately shows the root cause.
  console.error('FATAL: REDIS_HOST environment variable is not set. Exiting.');
  process.exit(1);
}

const redisClient = createClient({
  url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
});

let redisReady = false;

redisClient.on('error', (err) => {
  console.error('Redis client error:', err.message);
  redisReady = false;
});

redisClient.on('ready', () => {
  console.log('Connected to Redis at', REDIS_HOST + ':' + REDIS_PORT);
  redisReady = true;
});

redisClient.connect().catch((err) => {
  console.error('Initial Redis connection failed:', err.message);
});

// Liveness: is the process itself alive/responsive? Doesn't check Redis —
// a Redis blip shouldn't cause Kubernetes to kill and restart this pod.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: can this pod actually serve traffic right now?
// If Redis isn't ready, we tell Kubernetes to stop routing traffic here
// (pulled from Service endpoints) without restarting the container.
app.get('/ready', (req, res) => {
  if (redisReady) {
    return res.status(200).json({ status: 'ready' });
  }
  return res.status(503).json({ status: 'not ready', reason: 'redis not connected' });
});

// Simple business endpoint that actually exercises the DB dependency
app.get('/count', async (req, res) => {
  try {
    const count = await redisClient.incr('hit_count');
    res.status(200).json({ hits: count });
  } catch (err) {
    res.status(500).json({ error: 'failed to reach redis', detail: err.message });
  }
});

app.get('/', (req, res) => {
  res.status(200).send('devops-challenge backend is running');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
