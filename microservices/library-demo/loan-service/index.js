const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 5002;

app.use(express.json());

const BOOK_SERVICE = process.env.BOOK_SERVICE_URL || 'http://book-service:5001';
const MEMBER_SERVICE = process.env.MEMBER_SERVICE_URL || 'http://member-service:5003';

const loans = {};
let loanCounter = 1;

// POST /loans — create a loan
// Calls member-service/validate (❌ misplaced there) then book-service/books/:id
app.post('/loans', async (req, res) => {
  const { memberId, bookId } = req.body;
  if (!memberId || !bookId) {
    return res.status(400).json({ error: 'memberId and bookId are required' });
  }

  try {
    // Validate member — calls the misplaced function in member-service
    const validateRes = await fetch(`${MEMBER_SERVICE}/members/${memberId}/validate`, { method: 'POST' });
    const validation = await validateRes.json();
    if (!validation.valid) {
      return res.status(403).json({ error: `Member validation failed: ${validation.reason}` });
    }

    // Check book exists
    const bookRes = await fetch(`${BOOK_SERVICE}/books/${bookId}`);
    if (!bookRes.ok) return res.status(404).json({ error: 'Book not found' });
    const book = await bookRes.json();

    const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days
    const loan = {
      id: String(loanCounter++),
      memberId,
      bookId,
      bookTitle: book.title,
      memberTier: validation.tier,
      createdAt: new Date().toISOString(),
      dueDate: dueDate.toISOString(),
      returned: false,
    };
    loans[loan.id] = loan;

    res.status(201).json({ message: 'Loan created', data: loan });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create loan', detail: err.message });
  }
});

// POST /loans/:id/return — return a book
// Calls book-service/calculate-late-fee (❌ misplaced there)
app.post('/loans/:id/return', async (req, res) => {
  const loan = loans[req.params.id];
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.returned) return res.status(400).json({ error: 'Already returned' });

  try {
    // Calculate late fee — calls the misplaced function in book-service
    const feeRes = await fetch(`${BOOK_SERVICE}/calculate-late-fee`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dueDateStr: loan.dueDate,
        returnDateStr: new Date().toISOString(),
        dailyRate: loan.memberTier === 'premium' ? 0.25 : 0.50,
      }),
    });
    const feeData = await feeRes.json();

    loan.returned = true;
    loan.returnedAt = new Date().toISOString();
    loan.lateFee = feeData;

    res.json({ message: 'Book returned', data: loan });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process return', detail: err.message });
  }
});

// ✅ Correct home — loan-service owns its own loan list
app.get('/loans/active', (req, res) => {
  const active = Object.values(loans).filter(l => !l.returned);
  res.json(active);
});

// ✅ Correct home — loan-service owns loan history per member
app.get('/loans/member/:memberId', (req, res) => {
  const memberLoans = Object.values(loans).filter(l => l.memberId === req.params.memberId);
  res.json(memberLoans);
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'loan-service' }));

app.listen(PORT, () => console.log(`loan-service running on port ${PORT}`));
