const express = require('express');
const app = express();
const PORT = process.env.PORT || 5001;

app.use(express.json());

const books = {
  '1': { id: '1', title: 'Clean Code', author: 'Robert Martin', available: true },
  '2': { id: '2', title: 'The Pragmatic Programmer', author: 'Hunt & Thomas', available: true },
  '3': { id: '3', title: 'Design Patterns', author: 'Gang of Four', available: false },
};

// ✅ Correct home — mostly called by external clients browsing books
app.get('/books', (req, res) => {
  res.json(Object.values(books));
});

// ✅ Correct home — used by clients and loan-service (~50/50 split, borderline)
app.get('/books/:id', (req, res) => {
  const book = books[req.params.id];
  if (!book) return res.status(404).json({ error: 'Book not found' });
  res.json(book);
});

// ❌ MISPLACED — loan-service calls this ~90% of the time on every return.
// This function computes late fees which is loan business logic, not book catalog logic.
// The analyzer should recommend relocating this to loan-service.
app.post('/calculate-late-fee', (req, res) => {
  const { dueDateStr, returnDateStr, dailyRate } = req.body;
  const due = new Date(dueDateStr || Date.now());
  const returned = new Date(returnDateStr || Date.now());
  const daysLate = Math.max(0, Math.floor((returned - due) / (1000 * 60 * 60 * 24)));
  const rate = dailyRate || 0.50;
  const fee = parseFloat((daysLate * rate).toFixed(2));
  res.json({ daysLate, fee, currency: 'USD' });
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'book-service' }));

app.listen(PORT, () => console.log(`book-service running on port ${PORT}`));
