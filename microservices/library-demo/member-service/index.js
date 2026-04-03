const express = require('express');
const app = express();
const PORT = process.env.PORT || 5003;

app.use(express.json());

const members = {
  'm1': { id: 'm1', name: 'Alice Johnson', email: 'alice@library.com', active: true, tier: 'premium' },
  'm2': { id: 'm2', name: 'Bob Smith', email: 'bob@library.com', active: true, tier: 'standard' },
  'm3': { id: 'm3', name: 'Carol White', email: 'carol@library.com', active: false, tier: 'standard' },
};

// ✅ Correct home — clients look up member profiles
app.get('/members/:id', (req, res) => {
  const member = members[req.params.id];
  if (!member) return res.status(404).json({ error: 'Member not found' });
  res.json(member);
});

// ❌ MISPLACED — loan-service calls this ~95% of the time before creating every loan.
// Membership validation is part of the loan workflow, not member profile management.
// The analyzer should recommend relocating this to loan-service.
app.post('/members/:id/validate', (req, res) => {
  const member = members[req.params.id];
  if (!member) return res.status(404).json({ valid: false, reason: 'Member not found' });
  if (!member.active) return res.status(403).json({ valid: false, reason: 'Member account is inactive' });
  res.json({ valid: true, memberId: member.id, tier: member.tier });
});

// ✅ Correct home — admin endpoint to update member details
app.put('/members/:id', (req, res) => {
  const member = members[req.params.id];
  if (!member) return res.status(404).json({ error: 'Member not found' });
  Object.assign(member, req.body);
  res.json({ message: 'Member updated', data: member });
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'member-service' }));

app.listen(PORT, () => console.log(`member-service running on port ${PORT}`));
