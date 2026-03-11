const express = require('express');
const axios = require('axios');
const { trace } = require('@opentelemetry/api');

const app = express();
const PORT = process.env.PORT || 8080;
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:8081';
const PRODUCT_URL = process.env.PRODUCT_URL || 'http://localhost:8082';

app.get('/api/checkout', async (req, res) => {
    // We get the tracer from the global API
    const tracer = trace.getTracer('gateway-service');

    await tracer.startActiveSpan('gateway-checkout-flow', async (span) => {
        try {
            // 1. Authenticate user repeatedly (simulating an inefficient architecture = high external calls)
            for (let i = 0; i < 5; i++) {
                await axios.get(`${AUTH_URL}/validate?token=abc`);
            }

            // 2. Fetch products
            const products = await axios.get(`${PRODUCT_URL}/products`);

            res.json({
                status: 'success',
                message: 'Checkout complete',
                items: products.data
            });
        } catch (error) {
            span.recordException(error);
            res.status(500).json({ error: 'Checkout failed' });
        } finally {
            span.end();
        }
    });
});

app.listen(PORT, () => {
    console.log(`Gateway service listening on port ${PORT}`);
});
