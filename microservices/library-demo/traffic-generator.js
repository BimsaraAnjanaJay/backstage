/**
 * Traffic generator for library-demo.
 * Continuously exercises the loan workflow so cross-service traces are generated:
 *   loan-service → member-service/validate   (❌ misplaced)
 *   loan-service → book-service/calculate-late-fee  (❌ misplaced)
 */

const http = require('http');

const LOAN_URL = process.env.LOAN_SERVICE_URL || 'http://loan-service:5002';
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '3000', 10);

// IDs must match book-service seed data (1,2,3) and active members (m1,m2)
const MEMBERS = ['m1', 'm2', 'm1', 'm2', 'm1']; // m3 is inactive, keep active members
const BOOKS = ['1', '2', '3', '1', '2'];

function httpRequest(url, method, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let iteration = 0;

async function runCycle() {
  iteration++;
  const memberId = MEMBERS[iteration % MEMBERS.length];
  const bookId = BOOKS[iteration % BOOKS.length];

  try {
    // 1. Create a loan (triggers member-service/validate)
    const createRes = await httpRequest(`${LOAN_URL}/loans`, 'POST', { memberId, bookId });
    if (createRes.status === 201) {
      const loanId = createRes.body.data?.id;
      console.log(`[cycle ${iteration}] Loan created id=${loanId} member=${memberId} book=${bookId}`);

      // 2. Return the book (triggers book-service/calculate-late-fee)
      if (loanId) {
        const returnRes = await httpRequest(`${LOAN_URL}/loans/${loanId}/return`, 'POST', {});
        console.log(`[cycle ${iteration}] Return status=${returnRes.status}`);
      }
    } else {
      console.log(`[cycle ${iteration}] Loan creation status=${createRes.status}`, JSON.stringify(createRes.body));
    }
  } catch (err) {
    console.error(`[cycle ${iteration}] Error:`, err.message);
  }
}

async function waitForLoanService() {
  console.log('Waiting for loan-service to be ready...');
  for (let i = 0; i < 30; i++) {
    try {
      const res = await httpRequest(`${LOAN_URL}/health`, 'GET', null);
      if (res.status === 200) {
        console.log('loan-service is ready.');
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.warn('loan-service did not become ready in time, starting anyway.');
}

async function main() {
  await waitForLoanService();
  console.log(`Traffic generator started. Interval: ${INTERVAL_MS}ms`);
  setInterval(runCycle, INTERVAL_MS);
  runCycle(); // run immediately on start
}

main();
