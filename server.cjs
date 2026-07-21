const express = require('express')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const app = express()
const port = process.env.PORT || 4174
const dataPath = path.join(__dirname, 'data', 'helm-data.json')
const sessions = new Map()
app.use(express.json())

function database() {
  try { return JSON.parse(fs.readFileSync(dataPath, 'utf8')) }
  catch { return { users: [] } }
}
function save(data) { fs.mkdirSync(path.dirname(dataPath), { recursive: true }); fs.writeFileSync(dataPath, JSON.stringify(data, null, 2)) }
function tokenFor(user) { const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id); return token }
function account(req, res, next) {
  const token = req.get('authorization')?.replace('Bearer ', '')
  const userId = sessions.get(token)
  const user = database().users.find((item) => item.id === userId)
  if (!user) return res.status(401).json({ error: 'Please sign in.' })
  req.user = user; req.token = token; next()
}

app.post('/api/auth/register', async (req, res) => {
  const name = String(req.body.name || '').trim(); const email = String(req.body.email || '').trim().toLowerCase(); const password = String(req.body.password || '')
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({ error: 'Enter your name, a valid email, and an 8+ character password.' })
  const db = database()
  if (db.users.some((user) => user.email === email)) return res.status(409).json({ error: 'An account with that email already exists.' })
  const user = { id: crypto.randomUUID(), name, email, passwordHash: await bcrypt.hash(password, 12), data: { markers: [], destinations: [], trips: [] } }
  db.users.push(user); save(db)
  res.status(201).json({ token: tokenFor(user), user: { id: user.id, name: user.name, email: user.email } })
})
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(); const password = String(req.body.password || '')
  const user = database().users.find((item) => item.email === email)
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect.' })
  res.json({ token: tokenFor(user), user: { id: user.id, name: user.name, email: user.email } })
})
app.post('/api/auth/logout', account, (req, res) => { sessions.delete(req.token); res.status(204).end() })
app.get('/api/auth/me', account, (req, res) => res.json({ id: req.user.id, name: req.user.name, email: req.user.email }))
app.get('/api/navigation', account, (req, res) => res.json(req.user.data || { markers: [], destinations: [], trips: [] }))
app.put('/api/navigation', account, (req, res) => {
  const { markers = [], destinations = [], trips = [] } = req.body || {}
  const db = database(); const user = db.users.find((item) => item.id === req.user.id)
  user.data = { markers, destinations, trips }; save(db); res.status(204).end()
})

app.use(express.static(path.join(__dirname, 'dist')))
app.use((_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')))
app.listen(port, () => console.log(`Helm is running at http://localhost:${port}`))
