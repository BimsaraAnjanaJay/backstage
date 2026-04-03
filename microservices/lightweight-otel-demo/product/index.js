const express = require('express');
const { trace } = require('@opentelemetry/api');

const app = express();
const PORT = process.env.PORT || 8082;
const tracer = trace.getTracer('product-service');

async function fetchFromDB() {
    return new Promise((resolve) => {
        tracer.startActiveSpan('product-fetchFromDB', (span) => {
            setTimeout(() => {
                span.end();
                resolve([
                    { id: 1, name: 'Laptop', price: 999 },
                    { id: 2, name: 'Mouse', price: 25 }
                ]);
            }, 50);
        });
    });
}

app.get('/products', async (req, res) => {
    await tracer.startActiveSpan('product-list-endpoints', async (span) => {
        try {
            const products = await fetchFromDB();
            res.json(products);
        } finally {
            span.end();
        }
    });
});

app.listen(PORT, () => {
    console.log(`Product service listening on port ${PORT}`);
});
