const express = require('express');
const { trace } = require('@opentelemetry/api');

const app = express();
const PORT = process.env.PORT || 8081;
const tracer = trace.getTracer('auth-service');

// This function is the target. We want the Analyzer to see it's called constantly by Gateway.
async function extractTokenHash(token) {
    return new Promise((resolve) => {
        tracer.startActiveSpan('auth-extractTokenHash', (span) => {
            // Simulated work
            setTimeout(() => {
                span.setAttribute('token.length', token.length);
                span.end();
                resolve(`hash_${token}_123`);
            }, 10);
        });
    });
}

function internalValidationStep(hash) {
    return new Promise((resolve) => {
        tracer.startActiveSpan('auth-internalValidationStep', (span) => {
            setTimeout(() => {
                span.setAttribute('hash', hash);
                span.end();
                resolve(true);
            }, 5);
        });
    });
}

app.get('/validate', async (req, res) => {
    const token = req.query.token || 'default';

    await tracer.startActiveSpan('auth-validate-endpoint', async (span) => {
        try {
            const hash = await extractTokenHash(token);
            const isValid = await internalValidationStep(hash);

            res.json({ valid: isValid, user: 'admin' });
        } finally {
            span.end();
        }
    });
});

app.listen(PORT, () => {
    console.log(`Auth service listening on port ${PORT}`);
});
