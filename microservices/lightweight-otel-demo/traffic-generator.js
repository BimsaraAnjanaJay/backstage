const axios = require('axios');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const CONCURRENCY = 5;
const REQUESTS_PER_WORKER = 20;

async function generateTraffic(workerId) {
    for (let i = 0; i < REQUESTS_PER_WORKER; i++) {
        try {
            await axios.get(`${GATEWAY_URL}/api/checkout`);
            console.log(`[Worker ${workerId}] Request ${i + 1} succeeded`);
        } catch (error) {
            console.error(`[Worker ${workerId}] Request ${i + 1} failed:`, error.message);
        }

        // Random pause between 100ms and 500ms
        await new Promise(resolve => setTimeout(resolve, Math.random() * 400 + 100));
    }
}

async function start() {
    console.log(`Starting traffic generation to ${GATEWAY_URL}`);
    const workers = [];

    for (let i = 0; i < CONCURRENCY; i++) {
        workers.push(generateTraffic(i));
    }

    await Promise.all(workers);
    console.log('Traffic generation complete.');
}

start();
